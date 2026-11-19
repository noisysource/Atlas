// Who's talking (#290): Atlas is shared with the household, so the page keeps
// who it's talking to, and switches when someone says who they are ("it's
// Marisa", "sou a Marisa", "olá Atlas, aqui é a Marisa"). Pure, for tests.

/** @typedef {{ id: string, name: string }} Person */

/** Lower case, no accents, one space. @param {string} text */
export const plain = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const GREETING = "(?:(?:hi|hey|hello|ola|oi|bom dia|boa tarde|boa noite)[,!.]? )?(?:atlas[,!.]? )?";
const INTRO = "(?:it's|it is|this is|i'm|i am|here's|me,|sou|sou eu,|aqui e|aqui fala|fala|e a|e o)";

/**
 * The person a message says is talking, when it opens by saying so; undefined otherwise.
 * @param {string} text @param {readonly Person[]} people
 * @returns {Person | undefined}
 */
export const switchPhrase = (text, people) => {
  const t = plain(text);
  for (const p of people) {
    const name = plain(p.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name === "") continue;
    const said = new RegExp(`^${GREETING}${INTRO} (?:a |o )?${name}(?![a-z])`);
    if (said.test(t)) return p;
  }
  return undefined;
};

/**
 * The person the page talks to: the one it last talked to, if still in the
 * household, else the first (the main user).
 * @param {string | null} saved @param {readonly Person[]} people
 */
export const currentPerson = (saved, people) => people.find((p) => p.id === saved) ?? people[0];

/** The question box's hint: for anyone but the main user, whose it is. @param {Person | undefined} person @param {readonly Person[]} people */
export const placeholderFor = (person, people) => (person && people[0] && person.id !== people[0].id ? `Ask Atlas, ${person.name}…` : "Ask Atlas…");
