// Looks for details in a draft report that could identify the reporter. It only runs in
// memory: the text is never stored or logged, and warnings never quote it back.

const MESSAGES = {
  EMAIL: 'This looks like an email address. Remove it if you want to stay anonymous.',
  PHONE: 'This looks like a phone number. Remove it if you want to stay anonymous.',
  NAME: 'This looks like it includes a name. Remove it if you want to stay anonymous.',
  SOCIAL_MEDIA: 'This looks like a social media handle or profile link. Remove it if you want to stay anonymous.',
  ID_NUMBER: 'This looks like an ID number, such as an employee or registration number. Remove it if you want to stay anonymous.',
} as const;

type LeakType = keyof typeof MESSAGES;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

const PROFILE_URL =
  /\b(?:https?:\/\/)?(?:www\.)?(?:(?:facebook|fb|instagram|twitter|x|linkedin|tiktok|youtube|github|reddit|snapchat)\.com|threads\.net|t\.me)\/[\w.\/-]+/gi;

// The lookbehind keeps the part after @ in an email address from counting as a handle.
const HANDLE = /(?<![\w@.])@[a-z0-9_][a-z0-9_.]{1,29}/gi;

const PHONES = [
  // Indian mobiles: 10 digits starting 6-9, optionally with +91 or a leading 0.
  /(?<![\d+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
  // Other international numbers written with a country code.
  /\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}/g,
  // Landlines with an STD code, such as 011-23456789.
  /(?<!\d)0\d{2,4}[\s-]\d{6,8}(?!\d)/g,
];

const NAME_INTRO = /\b(?:[Mm]y name is|I am|I'm|[Tt]his is)\s+([A-Z][a-z]+)/g;

// Capitalised words that often follow "I am" or "This is" at the start of a sentence.
const NOT_NAMES = new Set([
  'The', 'A', 'An', 'Not', 'Very', 'So', 'Also', 'Just', 'Still', 'Really', 'Sure', 'Here', 'Now',
  'Writing', 'Reporting', 'Afraid', 'Worried', 'Scared', 'Urgent', 'Serious', 'Important', 'About',
  'In', 'On', 'At', 'From', 'With', 'My', 'Our', 'Your', 'This', 'That', 'It', 'What', 'How',
]);

const AADHAAR = /(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)/;

// Fiscal years and quarters look like IDs but are not personal.
const PERIOD = /^(?:fy|q[1-4]|h[12])?[-/]?\d{4}(?:[-/]\d{2,4})?$/i;

function hasName(text: string) {
  return [...text.matchAll(NAME_INTRO)].some((match) => !NOT_NAMES.has(match[1]));
}

function isIdLike(token: string) {
  const word = token.replace(/^\W+|\W+$/g, '');
  if (PERIOD.test(word)) return false;

  const digits = word.replace(/\D/g, '').length;
  const hasLetter = /[a-z]/i.test(word);
  return (hasLetter && digits >= 4 && word.length >= 6) || /^\d{8,}$/.test(word);
}

function hasIdNumber(text: string) {
  return AADHAAR.test(text) || text.split(/[\s,;:()]+/).some(isIdLike);
}

export function findIdentityLeaks(text: string) {
  const found = new Set<LeakType>();
  let rest = text;

  // Each match is blanked out once found, so an email or phone number is not
  // reported a second time as a handle or an ID number.
  function take(type: LeakType, pattern: RegExp) {
    if (!rest.match(pattern)) return;
    found.add(type);
    rest = rest.replace(pattern, ' ');
  }

  take('EMAIL', EMAIL);
  take('SOCIAL_MEDIA', PROFILE_URL);
  for (const pattern of PHONES) take('PHONE', pattern);
  take('SOCIAL_MEDIA', HANDLE);
  if (hasName(rest)) found.add('NAME');
  if (hasIdNumber(rest)) found.add('ID_NUMBER');

  return [...found].map((type) => ({ type, message: MESSAGES[type] }));
}
