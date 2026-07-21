#!/usr/bin/env bash
# A stand-in for a real `claude` agent session, used for the walking-skeleton
# demo and tests. It speaks the same PTY protocol the harness listens for:
#   - prints some work output
#   - prints the WAITING sentinel with a reason, then blocks on stdin
#   - after receiving a line, prints more output and the DONE sentinel
#
# Configure the harness to use this via `claudeCommand` to exercise the whole
# loop without a live model. The real `claude` binary replaces it unchanged.
set -u

echo "[mock-agent] starting in $(pwd)"
echo "[mock-agent] prompt: ${LUBBDUBB_PROMPT:-<none>}"
sleep 0.2
echo "[mock-agent] analyzing the task..."
sleep 0.2

# Ask for input the way a real agent hitting an ambiguous decision would.
echo "@@LUBBDUBB_WAITING:Need a decision — should I proceed with the risky refactor?@@"

# Block until the harness types an answer.
read -r ANSWER
echo "[mock-agent] got answer: ${ANSWER}"
sleep 0.2
echo "[mock-agent] applying changes and finishing up."
sleep 0.2
echo "@@LUBBDUBB_DONE@@"
