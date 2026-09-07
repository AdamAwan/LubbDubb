// → docs/spec/08-planning.md#atoms

export function atomNote(): string {
  return (
    `\n\n## The atoms of this change\n\n` +
    `Beside \`parts\`, declare \`atoms\`: a flat list of the smallest pieces of this change that could **land on ` +
    `their own, be reviewed on their own, and be rolled back on their own without breaking the tree**. Then say ` +
    `which atoms each part carries. Every atom must be carried by exactly one part, and the parts must not end ` +
    `up depending on each other in a circle.\n\n` +
    `  "atoms": [\n` +
    `    {"slug": "resolve-job-origin", "title": "...", "intent": "why this piece exists",\n` +
    `     "touches": ["web/src/view/goalPage.ts"], "acceptance": "...", "dependsOn": [],\n` +
    `     "rejected": [{"route": "what you could have done instead", "because": "why you did not"}]}\n` +
    `  ],\n` +
    `  "parts": [{"slug": "resolve", "atoms": ["resolve-job-origin"], "title": "...", "scope": "..."}]\n\n` +
    `**The test is independent revertability, never size.** Ask it of each atom you are about to write down: if ` +
    `this shipped by itself and somebody reverted it tomorrow, would what is left still build, still pass, and ` +
    `still make sense? If the answer is no, it is not an atom — it is half of one, and it belongs with the other ` +
    `half. "Add the type", "add the field", "add the test" are not three atoms: nothing works until all three ` +
    `land, so they are one.\n\n` +
    `**A plan is not better for having more atoms in it.** Nothing counts them and nothing refuses a plan for ` +
    `having few. A change that is genuinely one indivisible move is one atom, and saying so is the right answer ` +
    `rather than a lazy one. Fourteen slices that must all land together are worse than one honest atom: they ` +
    `cost a reader fourteen readings and buy no decision they could actually make.\n\n` +
    `\`rejected\` is the field nothing else can recover. \`alternatives\` is why this approach for the whole plan; ` +
    `\`rejected\` is why *this piece* is written this way rather than the other way you weighed. Write it where ` +
    `you actually weighed something, and leave it empty where you did not.`
  );
}
