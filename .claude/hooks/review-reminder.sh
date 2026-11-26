#!/bin/sh
# PreToolUse hook: on a branch's first push or PR, asks Claude to run /simplify and /code-review.
input=$(cat)
case "$input" in
  *'"tool_name":"Bash"'*|*'"tool_name": "Bash"'*)
    cmd=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tool_input?.command??""))')
    printf '%s\n' "$cmd" | grep -Eq '(^|[;&|(]) *git( +-C +[^ ]+)? +push( |$)' || exit 0 ;;
esac
dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
base=$(git merge-base HEAD origin/main 2>/dev/null) || exit 0
git diff --quiet "$base" -- src web scripts && exit 0
branch=$(git rev-parse --abbrev-ref HEAD)
stamp="$dir/lubbdubb-review-stamp"
grep -qxF "$branch" "$stamp" 2>/dev/null && exit 0
echo "$branch" >> "$stamp"
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"First push of this branch. Run the /simplify skill, then the /code-review skill, on its diff, apply what they find, then push again."}}'
