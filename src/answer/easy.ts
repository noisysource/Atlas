// Easy questions to the local model (#171), an idea from OpenJarvis: Claude
// is kept for what needs it. A question is easy when it needs none of Atlas's
// tools (by its words, and the last answers didn't use any), is short, isn't
// asking for something long or careful (write, draft, plan, code, analyse),
// and has no attachment. Rules only for now: the dataset (#295) keeps which
// brain answered and whether he corrected it, so the rules can be checked
// against what happens, and a learned router can come later.

import { groupsByWords, groupsUsedLately, normalise } from "./tool-groups.js";

export const EASY_MAX_CHARS = 280;

// Asking for work that a small model does worse: kept on the brain he chose.
const HARD = /\b(write|draft|compose|rewrite|essay|letter|email|code|script|program|debug|plan|planning|strategy|analy[sz]\w*|compare|comparison|research|summari[sz]e|review|proposal|contract|legal|tax\w*|invoice\w*|escreve\w*|redige\w*|rascunho|carta|codigo|programa\w*|planeia\w*|plano|estrategia|analisa\w*|analise|compara\w*|pesquisa\w*|resume|resumo|revê|reve|proposta|contrato|imposto\w*|fatura\w*)\b/;

export type EasyCheck = { readonly easy: true } | { readonly easy: false; readonly why: string };

export const easyQuestion = (input: { readonly question: string; readonly history: readonly { readonly role: string; readonly tools?: readonly string[] }[]; readonly attachments?: number; readonly apps?: readonly string[] }): EasyCheck => {
  const q = input.question.trim();
  if (q.length === 0) return { easy: false, why: "empty" };
  if (q.length > EASY_MAX_CHARS) return { easy: false, why: "long" };
  if ((input.attachments ?? 0) > 0) return { easy: false, why: "attachment" };
  if (groupsByWords(q, input.apps ?? []).length > 0) return { easy: false, why: "needs tools" };
  if (groupsUsedLately(input.history).length > 0) return { easy: false, why: "follows a tool answer" };
  if (HARD.test(normalise(q))) return { easy: false, why: "asks for careful work" };
  return { easy: true };
};
