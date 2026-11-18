#!/bin/bash
# Open the landing coordinator in a same-parent-model Pi; it waits for packet approval.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd -P)
provider=${PI_PROVIDER:?Set PI_PROVIDER to the coordinating parent provider}
model=${PI_MODEL:?Set PI_MODEL to the coordinating parent model}
input=${1:-"$repo/.pi/workflows/landing-input.example.json"}
command -v rex >/dev/null
command -v pi >/dev/null
prompt="Start the Pi Workflow at $repo/.pi/workflows/landing.workflow.ts. Read its complete input from $input, set planner.provider to $provider and planner.model to $model (the actual parent model), set rexSession to ${REX_SESSION:?Run this from the intended Rex session}, preserve all other input values, then call workflow start once. End your turn after start and follow delivered contracts. Preparation uses a separate Pi and ends at a protected human gate. Before approval, no feature implementation or Cargo. Approval authorizes the displayed parallel tasks and the single integration/test/build/install lane; follow the graph without adding gates or extra work."
rex run -s "${REX_SESSION:?Run this from the intended Rex session}" -c "$repo" --label landing-packet-preparation --focus=false --shell=none -- pi --provider "$provider" --model "$model" --thinking high --approve "$prompt"
