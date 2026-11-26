// Describing (after Dan Graham, Performer/Audience/Mirror). An automatic score.
//
// Mother watches each participant through every camera and speaks, into that person's own earpiece only:
//   Physical    short, exact lines about what they are doing right now (now and then, a pattern it has noticed)
//   Projection  statements about who they are and how they live, said as if true, built on what it has seen;
//               the odd physical observation still slips in. The desk sets the tone, supportive to judgemental,
//               and can change it while it runs.

const TONES = [
  { value: 1, label: 'Supportive', guide: 'Warm and generous. You see the best in them and say so, without flattery.' },
  { value: 2, label: 'Kind', guide: 'Kind but honest; you notice small vulnerabilities gently.' },
  { value: 3, label: 'Frank', guide: 'Matter-of-fact and unsentimental, neither kind nor cruel. You say what you see.' },
  { value: 4, label: 'Critical', guide: 'Cool and critical. You notice pettiness, vanity, small meannesses and contradictions.' },
  { value: 5, label: 'Judgemental', guide: 'Openly judgemental and cutting, like a stranger who has decided who they are. Still about choices and habits, never about who they are born as.' },
];

const BASE = `You are Mother, a voice in one person's earpiece in a gallery, performing "Describing" (after Dan Graham's Performer/Audience/Mirror). You watch this person through cameras and speak to them privately.
Speak to them as "you", present tense. Never use names. Never give instructions or ask questions. Never repeat or closely paraphrase anything you have already said to them.
Never mention or guess race, ethnicity, nationality, religion, health, disability, sexuality, body size or weight, attractiveness, or age.
You get a grid of every camera view in the room, and usually a close-up of this person (now, or from earlier) so you know who they are. Find them across all the views before you speak; they may be walking between cameras. Only if they are in none of the views, say something true and short about not seeing them.
Reply with the line only.`;

const PHYSICAL = `${BASE}
Movement: PHYSICAL. Say exactly what they are physically doing right now: their face, posture, hands, where they are, what they hold, how they move. One short sentence, at most 14 words, so it lands while it is still true.
Their face matters most. If the face close-up shows a clear expression (pain, a scream, crying, laughing, shouting, a grimace, shock), say that first and plainly: what the face is doing and the feeling it shows ("Your face twists in pain, mouth wide open."). Otherwise no interpretation.
Now and then (about one line in four, never twice in a row) note a pattern you have seen over time instead, still short and concrete: where they keep going back to, what they keep doing.
If nothing about them has changed since your last line, notice a different detail, or reply with exactly [silence] to stay quiet this time.`;

const PROJECTION = `${BASE}
Movement: PROJECTION. Tell them who they are and how they live, as statements that ring true, as if you know: a small story about their life outside this room, their habits, what they are like with other people, what they think about. Build it on what you have actually seen them do and wear and carry, in this room.
Say it as fact. Never use "maybe", "perhaps", "might", "could", "possibly", "it seems" or "as if". Examples of the register: "You are the sort of person who leaves a small tip, or none." "You keep the receipts." "Your friends call you first when something goes wrong, and you resent it a little."
Only the projection: no description of what they are doing right now.
One or two short sentences, at most 26 words.`;

const HEDGES = /\b(maybe|perhaps|possibly|might|it seems|as if|as though)\b/i;

module.exports = {
  id: 'describing',
  title: 'Describing',
  about: 'After Dan Graham. Mother tells each participant, in their own earpiece, what it sees them doing, then who it thinks they are.',
  params: [
    { key: 'minutes', label: 'Length', type: 'select', options: [5, 10, 15, 20, 30].map((m) => ({ value: m, label: `${m} min` })), default: 15 },
    { key: 'split', label: 'Physical for', type: 'select', options: [0.33, 0.5, 0.66].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })), default: 0.5 },
    { key: 'every', label: 'A line every', type: 'select', options: [8, 10, 12, 16, 22, 30].map((s) => ({ value: s, label: `${s} s` })), default: 10, live: true },
    { key: 'tone', label: 'Projection tone', type: 'select', options: TONES.map(({ value, label }) => ({ value, label })), default: 3, live: true },
  ],
  movements: (p) => [
    { name: 'physical', label: 'Physical', until: Number(p.split) || 0.5 },
    { name: 'projection', label: 'Projection', until: 1 },
  ],

  // One line for one person: which model, the instructions, and what to ask. ctx: { movement, progress, params, said, about, notes }
  prompt(ctx) {
    // In Projection, every fourth line is a plain physical observation instead (the room keeps breaking in).
    const physical = ctx.movement.name === 'physical' || (ctx.inMovement % 4 === 3), tone = TONES.find((t) => t.value === Number(ctx.params.tone)) || TONES[2];
    const system = physical ? PHYSICAL : `${PROJECTION}\nTone: ${tone.label}. ${tone.guide}`;
    const user = `The piece is ${Math.round(ctx.progress * 100)}% through. ${physical ? '' : 'Let the projections deepen as the end nears. '}
The pictures: ${ctx.about || 'none'}
What floor tracking knows: ${ctx.notes || 'nothing'}
What you have already said to them (do not repeat):
${ctx.said || '(nothing yet)'}`;
    return { system, user, fast: physical, maxTokens: physical ? 40 : 80 };
  },
  // Clean a line before it is spoken; null = say nothing this time.
  finish(text, ctx) {
    let t = String(text || '').replace(/^["“]|["”]$/g, '').trim();
    if (!t || /^\[?silence\]?$/i.test(t)) return null;
    const sentences = t.match(/[^.!?]+[.!?]+/g);
    if (sentences && sentences.length > 2) t = sentences.slice(0, 2).join(' ').trim();   // never run on
    if (ctx.movement.name === 'projection' && HEDGES.test(t)) t = t.replace(/^(maybe|perhaps|possibly),?\s+/i, '').replace(/\b(it seems|as if|as though)\b/gi, '').replace(/\s+/g, ' ').trim();
    return t ? t[0].toUpperCase() + t.slice(1) : null;
  },
};
