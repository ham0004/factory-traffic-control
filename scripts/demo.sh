#!/usr/bin/env bash
# Walks through the 9 scenarios from the assessment against a running server.
# Usage: BASE=http://localhost:3000 bash scripts/demo.sh
set -u

BASE=${BASE:-http://localhost:3000}
RUN=$(date +%s)
SEQ=$((RUN % 100000 * 10))

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Call it on its own line, not inside $(...): a subshell would lose the incremented counter.
next_seq() { SEQ=$((SEQ + 1)); }

post() {
  echo "> POST $1 $2"
  curl -s -w '  [HTTP %{http_code}]\n' -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"
  echo
}

status() {
  curl -s "$BASE/api/junctions/A/status" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const j = JSON.parse(s);
      console.log(`  mode=${j.mode} stage=${j.stage.kind} phase=${j.phase} controller=${j.controller_status}`);
      console.log(`  desired=${JSON.stringify(j.desired_signals)}`);
      console.log(`  actual =${JSON.stringify(j.actual_signals)}`);
      console.log(`  queues =${JSON.stringify(j.queues)} pending=${j.pending_command?.command_id ?? "-"}`);
      if (j.alerts.length) console.log(`  alerts =${j.alerts.map((a) => a.code).join(", ")}`);
    });'
}

arrive() { # vehicle_id direction type
  next_seq
  post /api/sensor-events "{\"event_id\":\"evt-$RUN-$SEQ\",\"junction_id\":\"A\",\"direction\":\"$2\",\"event_type\":\"VEHICLE_ARRIVED\",\"vehicle_id\":\"$1\",\"vehicle_type\":\"$3\",\"sequence_no\":$SEQ,\"timestamp\":\"$(now)\"}"
}

clear_vehicle() { # vehicle_id direction
  next_seq
  post /api/sensor-events "{\"event_id\":\"evt-$RUN-$SEQ\",\"junction_id\":\"A\",\"direction\":\"$2\",\"event_type\":\"VEHICLE_CLEARED\",\"vehicle_id\":\"$1\",\"sequence_no\":$SEQ,\"timestamp\":\"$(now)\"}"
}

step() { echo; echo "=== $* ==="; }

step "0. Starting state"
post /api/simulator/settings '{"auto_ack":true,"ack_delay_ms":300}'
post /api/junctions/A/commands '{"command":"RETURN_TO_AUTOMATIC"}'
status

step "1. Normal traffic: vehicles from several directions"
arrive "EMP-$RUN-1" NORTH EMPLOYEE_VEHICLE
arrive "EMP-$RUN-2" SOUTH EMPLOYEE_VEHICLE
arrive "EMP-$RUN-3" EAST EMPLOYEE_VEHICLE
status

step "2. Priority traffic: trucks on EAST/WEST outweigh employee vehicles"
arrive "TRK-$RUN-1" EAST TRUCK
arrive "TRK-$RUN-2" WEST TRUCK
arrive "FRK-$RUN-1" WEST FORKLIFT
status
echo "  (the scheduler picks EAST_WEST once min green passes on NS and the score beats NS by 20%)"

step "3. Emergency preemption from EAST"
status
arrive "AMB-$RUN" EAST EMERGENCY
status
echo "  ...waiting 8s for YELLOW -> ALL_RED -> GREEN"
sleep 8
status

step "4. Manual override (rejected while the emergency is active, then accepted)"
post /api/junctions/A/commands '{"command":"MANUAL_GREEN_REQUEST","direction":"NORTH","issued_by":"demo"}'
clear_vehicle "AMB-$RUN" EAST
post /api/junctions/A/commands '{"command":"MANUAL_GREEN_REQUEST","direction":"NORTH","issued_by":"demo"}'
status
post /api/junctions/A/commands '{"command":"RETURN_TO_AUTOMATIC","issued_by":"demo"}'
post /api/junctions/A/commands '{"command":"FLASH_EVERYTHING_GREEN"}'

step "5. Duplicate event: same event twice, then same id with a different payload"
next_seq
DUP="evt-$RUN-dup"
DUP_BODY="{\"event_id\":\"$DUP\",\"junction_id\":\"A\",\"direction\":\"SOUTH\",\"event_type\":\"VEHICLE_ARRIVED\",\"vehicle_id\":\"DUP-$RUN\",\"vehicle_type\":\"FORKLIFT\",\"sequence_no\":$SEQ,\"timestamp\":\"$(now)\"}"
post /api/sensor-events "$DUP_BODY"
post /api/sensor-events "$DUP_BODY"
post /api/sensor-events "${DUP_BODY/FORKLIFT/TRUCK}"
status

step "6. Vehicle clearance, and a clear for a vehicle that never arrived"
arrive "CLR-$RUN" NORTH FORKLIFT
status
clear_vehicle "CLR-$RUN" NORTH
clear_vehicle "GHOST-$RUN" WEST
status
echo "  invalid events:"
post /api/sensor-events '{"event_id":"bad-1","junction_id":"A","direction":"UP","event_type":"VEHICLE_ARRIVED"}'
post /api/sensor-events "{\"event_id\":\"evt-$RUN-z\",\"junction_id\":\"Z\",\"direction\":\"NORTH\",\"event_type\":\"VEHICLE_ARRIVED\",\"vehicle_id\":\"V\",\"vehicle_type\":\"TRUCK\",\"sequence_no\":1,\"timestamp\":\"$(now)\"}"

step "7. Controller failure: ACKs stop arriving"
post /api/simulator/settings '{"auto_ack":false}'
# Ask for whichever phase is NOT green, so a signal change is actually needed.
PHASE=$(curl -s "$BASE/api/junctions/A/status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).phase))')
if [ "$PHASE" = "EAST_WEST" ]; then OTHER=NORTH; else OTHER=EAST; fi
post /api/junctions/A/commands "{\"command\":\"MANUAL_GREEN_REQUEST\",\"direction\":\"$OTHER\"}"
echo "  ...waiting 16s (min green, retry after 3s, DEGRADED after 6s)"
sleep 16
status
echo "  controller comes back:"
post /api/simulator/settings '{"auto_ack":true}'
sleep 6
status
echo "  controller reports OFFLINE, then ONLINE:"
post /api/device-status '{"junction_id":"A","device_type":"SIGNAL_CONTROLLER","status":"OFFLINE"}'
status
post /api/device-status '{"junction_id":"A","device_type":"SIGNAL_CONTROLLER","status":"ONLINE"}'
sleep 1
status
post /api/junctions/A/commands '{"command":"RETURN_TO_AUTOMATIC"}'

step "8. Restart"
echo "  Stop the server (Ctrl+C) and start it again, then:"
echo "    curl $BASE/api/junctions/A/status   -> ALL_RED, actual UNKNOWN until the new command is ACKed"
echo "    curl '$BASE/api/junctions/A/history?limit=5'   -> RECOVERY_STARTED"

step "9. Concurrent burst (truck, emergency, manual, duplicate emergency, ACK)"
PENDING=$(curl -s "$BASE/api/junctions/A/status" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).pending_command?.command_id ?? "none"))')
next_seq
TRUCK_BODY="{\"event_id\":\"evt-$RUN-burst-truck\",\"junction_id\":\"A\",\"direction\":\"NORTH\",\"event_type\":\"VEHICLE_ARRIVED\",\"vehicle_id\":\"TRK-$RUN-9\",\"vehicle_type\":\"TRUCK\",\"sequence_no\":$SEQ,\"timestamp\":\"$(now)\"}"
next_seq
EMG_BODY="{\"event_id\":\"evt-$RUN-burst-emg\",\"junction_id\":\"A\",\"direction\":\"EAST\",\"event_type\":\"VEHICLE_ARRIVED\",\"vehicle_id\":\"AMB2-$RUN\",\"vehicle_type\":\"EMERGENCY\",\"sequence_no\":$SEQ,\"timestamp\":\"$(now)\"}"
post /api/sensor-events "$TRUCK_BODY" &
post /api/sensor-events "$EMG_BODY" &
post /api/junctions/A/commands '{"command":"MANUAL_GREEN_REQUEST","direction":"WEST"}' &
post /api/sensor-events "$EMG_BODY" &
post /api/controller-events "{\"command_id\":\"$PENDING\",\"junction_id\":\"A\",\"status\":\"ACK\",\"actual_signals\":{\"NORTH\":\"RED\",\"SOUTH\":\"RED\",\"EAST\":\"RED\",\"WEST\":\"RED\"}}" &
wait
status
echo "  recent history:"
curl -s "$BASE/api/junctions/A/history?limit=12" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>JSON.parse(s).reverse().forEach(r=>console.log(`  ${r.created_at} ${r.event_type} ${r.direction ?? ""} ${r.new_state ?? ""} ${r.command_id ?? ""}`)))'
clear_vehicle "AMB2-$RUN" EAST > /dev/null
echo
echo "done."
