// Some requests need knowledge the local data does not have: who invested in OpenAI, Apple's
// suppliers, Nvidia's competitors. The script does not answer those itself. It hands them back
// to the agent in the chat (Claude Code or Codex), which searches the web and runs the command
// again with the tickers it found, as "<title>: <tickers>".
import { splitQuery, isTitledList } from './resolve.mjs';

// Words that make a request about relationships between companies, not about a sector.
export const RELATION = /\b(invest(?:ed|ors?|ments?|s|ing)?|backers?|backed|backing|funded|funders?|funding|shareholders?|stakes?|stakeholders?|owns?|owned|owners?|ownership|suppliers?|supplies|supplying|supply chain|vendors?|customers?|clients?|partners?|partnered|partnerships?|competitors?|competing|competes?|rivals?|peers?|exposure|exposed|benefit(?:s|ing|ted)? from|beneficiar(?:y|ies)|tied to|ties to|linked to|depends? on|dependent on|subsidiar(?:y|ies)|parent compan(?:y|ies)|spin-?offs?|acquired|acquirers?|acquisitions?|bought|portfolios?|holdings?|holds|positions|13f)\b/i;

export const isRelational = q => RELATION.test(String(q || ''));

// Splits "dow jones and nvidia competitors" into what the local data answers ("dow jones") and
// questions for the chat ("nvidia competitors"). A part right after a question that matches
// nothing locally belongs to it: "suppliers of apple and samsung" stays one question.
// `local(text)` resolves text locally and returns { sections, unmatched }.
export function splitResearch(q, local) {
  if (isTitledList(q) || !isRelational(q)) return { localText: q, questions: [] }; // "OpenAI investors: MSFT" is a named list
  const localParts = [], questions = [];
  let afterQuestion = false;
  for (const seg of splitQuery(q)) {
    if (isRelational(seg)) { questions.push(seg); afterQuestion = true; }
    else if (afterQuestion && !local(seg).sections.length) questions[questions.length - 1] += ' and ' + seg;
    else { localParts.push(seg); afterQuestion = false; }
  }
  return { localText: localParts.join(', '), questions };
}
