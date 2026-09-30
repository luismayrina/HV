/**
 * lib/verses/corpus.ts
 *
 * The curated King James Version corpus used for scripture recommendation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE — and a discrepancy in the source document
 * ─────────────────────────────────────────────────────────────────────────────
 * The study bounds the corpus to chapters that usage data identifies as most
 * frequently turned to during emotional distress:
 *
 *   Psalms 23, 34, 46, 55, 91, 94, 119; Isaiah 40-41; Philippians 4;
 *   Matthew 11; 1 Peter 5; Jeremiah 29
 *
 * and states that verses outside this set are not recommended.
 *
 * However, the study's own rules name several verses that fall OUTSIDE that
 * list: 2 Timothy 1:7 (ACUTE), Lamentations 3:22-23 and Psalm 143:8 (morning),
 * Psalm 4:8 (evening), and Exodus 14:14 (stillness). The two statements cannot
 * both hold.
 *
 * We include those named verses, because the rules that cite them are explicit
 * and a morning rule with no morning verses would be inert. Each one is marked
 * `outsideStatedScope: true` so the discrepancy is visible in the app and in
 * any write-up, rather than silently resolved.
 *
 * All text is King James Version, which is in the public domain.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Theological themes the recommender maps emotional states onto. */
export type VerseTheme =
  | 'peace'
  | 'comfort'
  | 'strength'
  | 'hope'
  | 'protection'
  | 'courage'
  | 'renewal'
  | 'rest'
  | 'stillness'
  | 'encouragement'
  | 'restoration';

export interface Verse {
  /** Stable identifier, e.g. "php-4-6". */
  id: string;
  /** Human-readable reference, e.g. "Philippians 4:6-7". */
  reference: string;
  /** King James Version text. */
  text: string;
  /** Themes this verse serves, most central first. */
  themes: VerseTheme[];
  /**
   * True when the verse is named by the study's rules but falls outside the
   * chapter list the study states as its corpus boundary.
   */
  outsideStatedScope?: boolean;
}

export const VERSES: Verse[] = [
  // ── Psalms ───────────────────────────────────────────────────────────────
  {
    id: 'ps-23-1',
    reference: 'Psalm 23:1-3',
    text: 'The LORD is my shepherd; I shall not want. He maketh me to lie down in green pastures: he leadeth me beside the still waters. He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.',
    themes: ['restoration', 'rest', 'comfort'],
  },
  {
    id: 'ps-23-4',
    reference: 'Psalm 23:4',
    text: 'Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me; thy rod and thy staff they comfort me.',
    themes: ['courage', 'comfort', 'protection'],
  },
  {
    id: 'ps-34-4',
    reference: 'Psalm 34:4',
    text: 'I sought the LORD, and he heard me, and delivered me from all my fears.',
    themes: ['courage', 'hope'],
  },
  {
    id: 'ps-34-17',
    reference: 'Psalm 34:17',
    text: 'The righteous cry, and the LORD heareth, and delivereth them out of all their troubles.',
    themes: ['hope', 'comfort'],
  },
  {
    id: 'ps-34-18',
    reference: 'Psalm 34:18',
    text: 'The LORD is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.',
    themes: ['comfort', 'hope'],
  },
  {
    id: 'ps-46-1',
    reference: 'Psalm 46:1',
    text: 'God is our refuge and strength, a very present help in trouble.',
    themes: ['peace', 'strength', 'protection'],
  },
  {
    id: 'ps-46-10',
    reference: 'Psalm 46:10',
    text: 'Be still, and know that I am God: I will be exalted among the heathen, I will be exalted in the earth.',
    themes: ['stillness', 'peace'],
  },
  {
    id: 'ps-55-22',
    reference: 'Psalm 55:22',
    text: 'Cast thy burden upon the LORD, and he shall sustain thee: he shall never suffer the righteous to be moved.',
    themes: ['comfort', 'strength', 'rest'],
  },
  {
    id: 'ps-91-1',
    reference: 'Psalm 91:1-2',
    text: 'He that dwelleth in the secret place of the most High shall abide under the shadow of the Almighty. I will say of the LORD, He is my refuge and my fortress: my God; in him will I trust.',
    themes: ['protection', 'peace'],
  },
  {
    id: 'ps-91-4',
    reference: 'Psalm 91:4',
    text: 'He shall cover thee with his feathers, and under his wings shalt thou trust: his truth shall be thy shield and buckler.',
    themes: ['protection', 'comfort'],
  },
  {
    id: 'ps-91-11',
    reference: 'Psalm 91:11',
    text: 'For he shall give his angels charge over thee, to keep thee in all thy ways.',
    themes: ['protection', 'courage'],
  },
  {
    id: 'ps-94-19',
    reference: 'Psalm 94:19',
    text: 'In the multitude of my thoughts within me thy comforts delight my soul.',
    themes: ['comfort', 'peace'],
  },
  {
    id: 'ps-119-50',
    reference: 'Psalm 119:50',
    text: 'This is my comfort in my affliction: for thy word hath quickened me.',
    themes: ['comfort', 'hope'],
  },
  {
    id: 'ps-119-105',
    reference: 'Psalm 119:105',
    text: 'Thy word is a lamp unto my feet, and a light unto my path.',
    themes: ['renewal', 'hope'],
  },
  {
    id: 'ps-119-114',
    reference: 'Psalm 119:114',
    text: 'Thou art my hiding place and my shield: I hope in thy word.',
    themes: ['protection', 'hope'],
  },

  // ── Isaiah 40-41 ─────────────────────────────────────────────────────────
  {
    id: 'isa-40-29',
    reference: 'Isaiah 40:29',
    text: 'He giveth power to the faint; and to them that have no might he increaseth strength.',
    themes: ['strength', 'restoration'],
  },
  {
    id: 'isa-40-31',
    reference: 'Isaiah 40:31',
    text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.',
    themes: ['restoration', 'renewal', 'strength'],
  },
  {
    id: 'isa-41-10',
    reference: 'Isaiah 41:10',
    text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God: I will strengthen thee; yea, I will help thee; yea, I will uphold thee with the right hand of my righteousness.',
    themes: ['strength', 'encouragement', 'courage'],
  },
  {
    id: 'isa-41-13',
    reference: 'Isaiah 41:13',
    text: 'For I the LORD thy God will hold thy right hand, saying unto thee, Fear not; I will help thee.',
    themes: ['courage', 'encouragement'],
  },

  // ── Philippians 4 ────────────────────────────────────────────────────────
  {
    id: 'php-4-6',
    reference: 'Philippians 4:6-7',
    text: 'Be careful for nothing; but in every thing by prayer and supplication with thanksgiving let your requests be made known unto God. And the peace of God, which passeth all understanding, shall keep your hearts and minds through Christ Jesus.',
    themes: ['peace', 'comfort'],
  },
  {
    id: 'php-4-13',
    reference: 'Philippians 4:13',
    text: 'I can do all things through Christ which strengtheneth me.',
    themes: ['strength', 'encouragement'],
  },
  {
    id: 'php-4-19',
    reference: 'Philippians 4:19',
    text: 'But my God shall supply all your need according to his riches in glory by Christ Jesus.',
    themes: ['hope', 'comfort'],
  },

  // ── Matthew 11, 1 Peter 5, Jeremiah 29 ───────────────────────────────────
  {
    id: 'mt-11-28',
    reference: 'Matthew 11:28-29',
    text: 'Come unto me, all ye that labour and are heavy laden, and I will give you rest. Take my yoke upon you, and learn of me; for I am meek and lowly in heart: and ye shall find rest unto your souls.',
    themes: ['rest', 'peace', 'comfort'],
  },
  {
    id: '1pe-5-7',
    reference: '1 Peter 5:7',
    text: 'Casting all your care upon him; for he careth for you.',
    themes: ['peace', 'comfort', 'rest'],
  },
  {
    id: 'jer-29-11',
    reference: 'Jeremiah 29:11',
    text: 'For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.',
    themes: ['hope', 'encouragement'],
  },

  // ── Named by the study's rules, outside its stated chapter list ──────────
  {
    id: '2ti-1-7',
    reference: '2 Timothy 1:7',
    text: 'For God hath not given us the spirit of fear; but of power, and of love, and of a sound mind.',
    themes: ['courage', 'protection', 'strength'],
    outsideStatedScope: true,
  },
  {
    id: 'lam-3-22',
    reference: 'Lamentations 3:22-23',
    text: 'It is of the LORD’s mercies that we are not consumed, because his compassions fail not. They are new every morning: great is thy faithfulness.',
    themes: ['renewal', 'hope'],
    outsideStatedScope: true,
  },
  {
    id: 'ps-143-8',
    reference: 'Psalm 143:8',
    text: 'Cause me to hear thy lovingkindness in the morning; for in thee do I trust: cause me to know the way wherein I should walk; for I lift up my soul unto thee.',
    themes: ['renewal', 'hope'],
    outsideStatedScope: true,
  },
  {
    id: 'ps-4-8',
    reference: 'Psalm 4:8',
    text: 'I will both lay me down in peace, and sleep: for thou, LORD, only makest me dwell in safety.',
    themes: ['rest', 'peace', 'protection'],
    outsideStatedScope: true,
  },
  {
    id: 'ex-14-14',
    reference: 'Exodus 14:14',
    text: 'The LORD shall fight for you, and ye shall hold your peace.',
    themes: ['stillness', 'protection'],
    outsideStatedScope: true,
  },
];

export const VERSE_BY_ID: Record<string, Verse> = Object.fromEntries(
  VERSES.map((v) => [v.id, v]),
);

export function versesWithTheme(theme: VerseTheme): Verse[] {
  return VERSES.filter((v) => v.themes.includes(theme));
}
