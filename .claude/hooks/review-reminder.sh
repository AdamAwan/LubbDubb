#!/bin/sh
# Stop hook: once per distinct change set, asks Claude to run /simplify and /code-review.
input=$(cat)
dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
base=$(git merge-base HEAD origin/main 2>/dev/null) || exit 0
diff=$(git diff "$base" -- src web scripts)
[ -z "$diff" ] && exit 0
stamp="$dir/lubbdubb-review-stamp"
hash=$(printf '%s' "$diff" | git hash-object --stdin)
[ "$(cat "$stamp" 2>/dev/null)" = "$hash" ] && exit 0
echo "$hash" > "$stamp"
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
printf '%s\n' '{"decision":"block","reason":"Source changed since the last review. Run the /simplify skill, then the /code-review skill, on this branch'"'"'s diff and apply what they find before finishing."}'
