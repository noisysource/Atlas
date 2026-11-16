// Answering a card by voice or by typing (#224): "yes" / "sim" / the card's own words.

const YES = [
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "go ahead", "go on", "do it", "please do", "confirm", "confirmed", "approve", "approved", "send it", "add it",
  "tidy it", "open it", "move them", "close it", "push it", "start it", "prepare it", "delete it", "that's fine", "sounds good", "correct", "right",
  "sim", "pode", "pode ser", "força", "confirma", "confirmo", "avança", "avanca", "claro", "está bem", "esta bem", "ok pode", "manda", "envia", "faz",
];
const NO = [
  "no", "nope", "nah", "don't", "do not", "not now", "not yet", "leave it", "leave them", "keep it", "keep as draft", "cancel", "stop", "never mind", "skip",
  "não", "nao", "deixa", "deixa estar", "cancela", "agora não", "agora nao", "não faças", "nao facas", "esquece",
];

/** @param {string} s */
const plain = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,!?;:"“”'’]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const yes = new Set(YES.map(plain));
const no = new Set(NO.map(plain));

/**
 * Whether a short reply answers the card waiting for an OK: "yes", "ok, send it", "sim", or the
 * card's own button words. Anything longer, or anything else, is a new question.
 * @param {string} text @param {{ yes?: string, no?: string }} [labels] @returns {"yes" | "no" | undefined}
 */
export const cardAnswer = (text, labels = {}) => {
  const t = plain(text);
  if (t === "" || t.split(" ").length > 5) return undefined;
  const own = (/** @type {string | undefined} */ l) => (l ? plain(l) : "");
  if (t === own(labels.yes)) return "yes";
  if (t === own(labels.no)) return "no";
  // "ok, send it" / "yes please": every part says the same.
  const parts = t
    .replace(/\bplease\b|\bpor favor\b|\bthanks\b|\bobrigado\b|\batlas\b/g, " ")
    .split(/\s*(?:\band\b|\be\b|\bthen\b)\s*|\s{2,}/)
    .join(" ")
    .trim();
  const said = (/** @type {Set<string>} */ set) => set.has(parts) || [...set].some((w) => parts === w || parts.startsWith(`${w} `) && set.has(parts.slice(w.length + 1)));
  if (said(no)) return "no";
  if (said(yes)) return "yes";
  return undefined;
};
