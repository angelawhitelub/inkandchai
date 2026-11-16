'use strict';
/**
 * Reading lists: SEO landing pages at /best-books/<slug>/ (owner, 16 Nov 2026).
 *
 * Hand-picked books with our own short notes, served by the Worker inside the
 * baked /books-under-299/ page shell. Prices come from the till at view time
 * (functions/reading-list.js); sold-out, taken-down or over-budget books drop
 * out by themselves, so a list never shows a book a customer cannot buy at the
 * price the page promises.
 *
 * Adding a list: add an entry to LISTS (slug, copy, picks). Every pick's slug
 * must be a live product page; tests check the shape, reading-list.js checks
 * the books.
 */

const SITE = 'https://inkandchai.in';
const BASE = '/best-books/';

const LISTS = [
  {
    slug: 'thriller-books-under-300',
    title: 'Best Thriller Books Under ₹300 in India (2026)',
    h1: 'Best Thriller Books Under ₹300',
    description: 'Psychological thrillers, murder mysteries and page-turners that cost ₹300 or less: Freida McFadden, Alex Michaelides, Holly Jackson, Lisa Jewell, Richard Osman and more. Cash on delivery across India.',
    maxPrice: 300,
    intro: 'Twisty, fast and impossible to put down, and every one of them costs ₹300 or less. These are the thrillers our readers keep coming back for, from Freida McFadden\'s one-sitting reads to the mysteries that started BookTok\'s obsession with crime fiction.',
    picks: [
      { slug: 'the-silent-patient-by-alex-michaelides-85469', name: 'The Silent Patient', by: 'Alex Michaelides', note: 'A famous painter shoots her husband and never says another word. The psychotherapist determined to make her talk has secrets of his own. Few thrillers have an ending this talked about.' },
      { slug: 'never-lie-by-freida-mcfadden-76605', name: 'Never Lie', by: 'Freida McFadden', note: 'Newlyweds snowed in at the house of a psychiatrist who vanished years ago find her hidden session recordings. Short chapters, constant reveals: the ideal first McFadden.' },
      { slug: 'the-housemaid-is-watching-by-freida-mcfadden-98845', name: 'The Housemaid Is Watching', by: 'Freida McFadden', note: 'Millie finally has a home and family of her own, and a neighbour who seems to be watching her every move. Readers of The Housemaid series will want this one.' },
      { slug: 'the-boyfriend-by-freida-mcfadden-51837', name: 'The Boyfriend', by: 'Freida McFadden', note: 'A dating-app romance with a doctor who seems perfect, while women in the city keep turning up dead. Paranoia turned up to full volume.' },
      { slug: 'the-teacher-by-freida-mcfadden-67101', name: 'The Teacher', by: 'Freida McFadden', note: 'A high-school scandal told from the staff room and the classroom, where nobody, teachers included, is quite who they claim to be.' },
      { slug: 'do-not-disturb-by-freida-mcfadden-21501', name: 'Do Not Disturb', by: 'Freida McFadden', note: 'Snowed in at an isolated inn: a woman with a secret, and a host with one of her own. Short chapters and a last-page sting, perfect for a long train journey.' },
      { slug: 'the-fury-by-alex-michaelides-70333', name: 'The Fury', by: 'Alex Michaelides', note: 'A reclusive film star, her friends and a private Greek island cut off by the wind. Someone dies, and the narrator is not as reliable as he seems.' },
      { slug: 'the-maidens-43389', name: 'The Maidens', by: 'Alex Michaelides', note: 'A dark academia murder mystery set in Cambridge, where a charismatic professor and his circle of devoted students sit at the centre of the investigation.' },
      { slug: 'the-good-girl-s-guide-to-murder-by-holly-jackson-73437', name: 'A Good Girl\'s Guide to Murder', by: 'Holly Jackson', note: 'A student reopens a closed local murder case for a school project, told partly through interview transcripts and case notes. A YA mystery adults love just as much.' },
      { slug: 'good-girl-bad-blood-by-holly-jackson-71261', name: 'Good Girl, Bad Blood', by: 'Holly Jackson', note: 'The second Pip Fitz-Amobi case: a friend\'s brother goes missing and the police won\'t act. Darker and faster than book one.' },
      { slug: 'as-good-as-dead-by-holly-jackson-14813', name: 'As Good as Dead', by: 'Holly Jackson', note: 'The finale of the trilogy, and the most gripping. Read the first two before this one.' },
      { slug: 'the-inheritance-games-international-ya-mystery-bestseller-by-jennifer-lynn-barne', name: 'The Inheritance Games', by: 'Jennifer Lynn Barnes', note: 'A teenager inherits a billionaire\'s fortune from a man she never met, plus a mansion full of puzzles and the family he disinherited. Pure escapist fun.' },
      { slug: 'the-thursday-murder-club-by-richard-osman-77149', name: 'The Thursday Murder Club', by: 'Richard Osman', note: 'Four friends in a retirement village solve cold cases for fun, until a real murder lands on their doorstep. A cosy mystery that is genuinely funny.' },
      { slug: 'the-man-who-died-twice-77021', name: 'The Man Who Died Twice', by: 'Richard Osman', note: 'The Thursday Murder Club\'s second case brings stolen diamonds, the mafia and Elizabeth\'s ex-husband. Even better than the first.' },
      { slug: 'the-family-upstairs-64381', name: 'The Family Upstairs', by: 'Lisa Jewell', note: 'On her 25th birthday, Libby inherits a London mansion and the story of what happened there decades ago. Eerie, sad and hard to stop reading.' },
      { slug: 'don-t-let-him-in-by-lisa-jewell-23645', name: 'Don\'t Let Him In', by: 'Lisa Jewell', note: 'A widow falls fast for a charming stranger, and her daughter and a woman across town are both sure he is not who he says. A slow-burn domestic thriller.' },
      { slug: 'verity-the-thriller-that-will-capture-your-heart-and-bl-07293', name: 'Verity', by: 'Colleen Hoover', note: 'A struggling writer is hired to finish a famous author\'s series and finds her unpublished autobiography. Colleen Hoover\'s most-recommended book outside romance.' },
      { slug: 'dark-matter-the-most-mind-blowing-and-twisted-thriller--28189', name: 'Dark Matter', by: 'Blake Crouch', note: 'A physics professor is abducted and wakes up in a life he never lived. A sci-fi thriller about the roads not taken that moves at breakneck speed.' },
      { slug: 'strange-pictures-the-japanese-mystery-sensation-by-uketsu', name: 'Strange Pictures', by: 'Uketsu', note: 'A Japanese mystery built around a set of strange drawings, each one hiding a clue. Short, unsettling and unlike anything else on this list.' },
      { slug: 'how-to-kill-your-family-by-bella-mackie-89533', name: 'How to Kill Your Family', by: 'Bella Mackie', note: 'A darkly funny confession from a woman in prison for the one murder she didn\'t commit. For readers who like their thrillers with a sharp sense of humour.' },
      { slug: 'a-slow-fire-burning-39261', name: 'A Slow Fire Burning', by: 'Paula Hawkins', note: 'A young man is found murdered on a London canal boat, and three women each have a reason to be suspected. From the author of The Girl on the Train.' },
      { slug: 'truly-devious-by-maureen-johnson-35677', name: 'Truly Devious', by: 'Maureen Johnson', note: 'A true-crime-obsessed student arrives at an elite school famous for an unsolved kidnapping in the 1930s, determined to crack it. Clever and atmospheric.' },
      { slug: 'the-royal-bengal-mystery-the-adventure-of-feluda-63997', name: 'The Royal Bengal Mystery (Feluda)', by: 'Satyajit Ray', note: 'India\'s favourite detective heads to the forests of North Bengal to crack an old family riddle. Classic, clean and perfect for younger readers too.' },
      { slug: 'silent-patient-never-lie-combo-2', name: 'The Silent Patient + Never Lie (Set of 2)', by: 'Alex Michaelides & Freida McFadden', note: 'Two of the best psychological thrillers in one parcel, for ₹300 or less. The easiest way to start.' },
    ],
    body: [
      '<h2>How we picked these thrillers</h2><p>Every book here is one our readers order again and again, and every one is ₹300 or less today. We left out anything that is just "dark" without being a page-turner. You will find psychological thrillers built around a final twist (Alex Michaelides, Freida McFadden), murder mysteries with a cast you will want to follow for a whole series (Richard Osman, Holly Jackson) and a few that are hard to categorise (Strange Pictures, Dark Matter).</p>',
      '<h2>Where to start</h2><p><strong>Short on time?</strong> Freida McFadden\'s books are built for one or two sittings. Start with <em>Never Lie</em>. <strong>Want the twist everyone talks about?</strong> <em>The Silent Patient</em>. <strong>Prefer a mystery you can solve along with the detective?</strong> <em>A Good Girl\'s Guide to Murder</em> or <em>The Thursday Murder Club</em>. <strong>Reading with a teenager?</strong> Holly Jackson, Jennifer Lynn Barnes, Maureen Johnson and Satyajit Ray\'s Feluda are all safe bets.</p>',
      '<h2>Pay less for delivery</h2><p>Two books from this list usually cross ₹399, and prepaid orders above ₹399 ship free across India. Cash on delivery is free from ₹499. Every order comes with 7-day returns and a free replacement if a copy arrives damaged.</p>',
    ],
    faq: [
      { q: 'What is the best thriller book under ₹300?', a: 'The Silent Patient by Alex Michaelides is our most recommended: a short, gripping psychological thriller with a famous final twist. If you want something faster, try Never Lie by Freida McFadden.' },
      { q: 'Which Freida McFadden book should I read first?', a: 'Never Lie or The Boyfriend are good standalone starting points. The Housemaid series should be read in order, starting with The Housemaid.' },
      { q: 'Are these thrillers suitable for teenagers?', a: 'Holly Jackson\'s Good Girl\'s Guide to Murder trilogy, The Inheritance Games, Truly Devious and Feluda are written for young adults. The adult thrillers here include violence and mature themes.' },
      { q: 'Can I pay cash on delivery?', a: 'Yes. Cash on delivery is available across India, and it is free on orders of ₹499 or more.' },
    ],
  },

  {
    slug: 'books-like-it-ends-with-us',
    title: 'Books Like It Ends With Us: Emotional Reads to Try Next',
    h1: 'Books Like It Ends With Us',
    description: 'Loved It Ends With Us? Try these emotional love stories next: more Colleen Hoover, Emily Henry, Carley Fortune, Taylor Jenkins Reid, Sally Rooney and more. Cash on delivery across India.',
    intro: 'Finished <em>It Ends With Us</em> and not ready to let go? These are the books our readers pick up next: love stories with real heartbreak, flawed people and endings that stay with you. We start with more Colleen Hoover, then branch out.',
    picks: [
      { group: 'Start here', slug: 'it-ends-with-us-a-novel-by-colleen-hoover-04573', name: 'It Ends With Us', by: 'Colleen Hoover', note: 'Haven\'t read it yet? Lily, Ryle and Atlas: the book that made Colleen Hoover a household name. A love story that is also about the courage to break a pattern.' },
      { group: 'Start here', slug: 'combo-set-it-start-with-us-it-ends-with-us-by-colleen-h-61501', name: 'It Ends With Us + It Starts With Us (Set of 2)', by: 'Colleen Hoover', note: 'Both books together, for readers who want Lily and Atlas\'s whole story in one go.' },
      { group: 'More Colleen Hoover', slug: 'it-starts-with-us-by-colleen-hoover-02877', name: 'It Starts With Us', by: 'Colleen Hoover', note: 'The sequel, told by Lily and Atlas. Gentler and more hopeful than the first book, and the closure many readers wanted.' },
      { group: 'More Colleen Hoover', slug: 'reminders-of-him-by-colleen-hoover-45213', name: 'Reminders of Him', by: 'Colleen Hoover', note: 'A mother released from prison tries to reconnect with the daughter she has never met. Hoover at her most emotional; keep tissues close.' },
      { group: 'More Colleen Hoover', slug: 'ugly-love-colleen-hoover', name: 'Ugly Love', by: 'Colleen Hoover', note: 'Tate and Miles agree to a relationship with two rules: no questions about the past, no expecting a future. Steamier, and more painful than it first looks.' },
      { group: 'More Colleen Hoover', slug: 'november-9-a-novel-character-development', name: 'November 9', by: 'Colleen Hoover', note: 'Two people agree to meet on the same date every year. A love story told in yearly chapters, with a secret at the centre.' },
      { group: 'More Colleen Hoover', slug: 'slammed-by-colleen-hoover-00573', name: 'Slammed', by: 'Colleen Hoover', note: 'Her first novel: grief, slam poetry and a love that has to wait. Quieter than her later books, and loved for it.' },
      { group: 'Emotional love stories', slug: 'the-seven-husbands-of-evelyn-hugo-by-taylor-jenkins-rei-82461', name: 'The Seven Husbands of Evelyn Hugo', by: 'Taylor Jenkins Reid', note: 'An ageing Hollywood star finally tells the truth about her seven marriages and the one great love of her life. Glamorous, sad and unforgettable.' },
      { group: 'Emotional love stories', slug: 'normal-people-by-sally-rooney-26013', name: 'Normal People', by: 'Sally Rooney', note: 'Marianne and Connell drift together and apart from school to university in Ireland. A quiet, honest book about how hard it is to say what you feel.' },
      { group: 'Emotional love stories', slug: 'meet-me-at-the-lake-the-breathtaking-new-novel-from-the-51325', name: 'Meet Me at the Lake', by: 'Carley Fortune', note: 'Two strangers spend one perfect day together and promise to meet a year later. He never shows. A second-chance romance with real ache.' },
      { group: 'Emotional love stories', slug: 'our-perfect-storm-by-carley-fortune-rtune', name: 'Our Perfect Storm', by: 'Carley Fortune', note: 'Carley Fortune\'s newest: a summer romance about second chances, full of nostalgia and longing.' },
      { group: 'Emotional love stories', slug: 'we-all-live-here-by-jojo-moyes-26109', name: 'We All Live Here', by: 'Jojo Moyes', note: 'A messy, warm family story from the author of Me Before You, about a woman whose household keeps growing just as her life falls apart.' },
      { group: 'Emotional love stories', slug: 'the-fault-in-our-stars-43485', name: 'The Fault in Our Stars', by: 'John Green', note: 'Two teenagers meet at a cancer support group and fall in love. Funny, honest and devastating: a modern classic.' },
      { group: 'Emotional love stories', slug: 'a-little-life-shortlisted-for-the-man-booker-prize-2015-59453', name: 'A Little Life', by: 'Hanya Yanagihara', note: 'Four friends in New York over several decades, and the trauma one of them carries. Long and very heavy; check content warnings before you start.' },
      { group: 'When you need something lighter', slug: 'funny-story-by-emily-henry-49533', name: 'Funny Story', by: 'Emily Henry', note: 'Two people dumped by their partners (who left them for each other) pretend to date. Witty banter with real emotional depth.' },
      { group: 'When you need something lighter', slug: 'great-big-beautiful-life-by-emily-henry-40957', name: 'Great Big Beautiful Life', by: 'Emily Henry', note: 'Two rival writers compete to tell a reclusive heiress\'s life story. Emily Henry\'s most ambitious book yet.' },
      { group: 'When you need something lighter', slug: 'book-lovers-contemporary-romance', name: 'Book Lovers', by: 'Emily Henry', note: 'A ruthless literary agent and a brooding editor keep running into each other in a tiny town. A love letter to readers.' },
      { group: 'When you need something lighter', slug: 'people-we-meet-on-vacation-crossword-recommends', name: 'People We Meet on Vacation', by: 'Emily Henry', note: 'Best friends who took a trip together every summer, until the one that went wrong. Ten years of friendship and longing.' },
      { group: 'When you need something lighter', slug: 'just-for-the-summer-by-abby-jimenez-19197', name: 'Just for the Summer', by: 'Abby Jimenez', note: 'Two people whose exes always find "the one" right after them decide to date each other to break the curse. Sweet, funny and surprisingly moving.' },
      { group: 'When you need something lighter', slug: 'the-love-hypothesis-by-ali-hazelwood-32189', name: 'The Love Hypothesis', by: 'Ali Hazelwood', note: 'A PhD student fake-dates the most intimidating professor in her department. The fake-dating romance that took over BookTok.' },
    ],
    body: [
      '<h2>What makes a book "like" It Ends With Us?</h2><p>Readers usually mean one of three things: more of Colleen Hoover\'s voice, a love story that deals with something difficult, or a book that makes them cry. This list covers all three. If you only want more Hoover, start with <em>Reminders of Him</em> and <em>Ugly Love</em>. If you want the emotional punch from a different writer, try <em>The Seven Husbands of Evelyn Hugo</em> or <em>Normal People</em>. If you need to recover with something lighter, Emily Henry is the answer.</p>',
      '<h2>A note on content</h2><p>It Ends With Us deals with domestic abuse, and several books here also include difficult themes such as grief, illness and trauma. <em>A Little Life</em> in particular is very heavy. If a subject is hard for you, read the content notes before you start.</p>',
      '<h2>Pay less for delivery</h2><p>Prepaid orders above ₹399 ship free across India, and cash on delivery is free from ₹499. Every order comes with 7-day returns and a free replacement if a copy arrives damaged.</p>',
    ],
    faq: [
      { q: 'What should I read after It Ends With Us?', a: 'Start with the sequel, It Starts With Us. After that, Reminders of Him is the Colleen Hoover book readers most often say made them cry just as much.' },
      { q: 'Is there a Hindi edition of It Ends With Us?', a: 'Yes, we stock the Hindi edition. Search for "It Ends With Us Hindi" on our site.' },
      { q: 'Which Colleen Hoover book is the saddest?', a: 'Readers most often name Reminders of Him and It Ends With Us. Ugly Love and November 9 are close behind.' },
      { q: 'Can I pay cash on delivery?', a: 'Yes. Cash on delivery is available across India, and it is free on orders of ₹499 or more.' },
    ],
  },

  {
    slug: 'books-for-upsc-aspirants',
    title: 'Best Books for UPSC Aspirants Beyond the Textbooks (2026 Reading List)',
    h1: 'Books for UPSC Aspirants: Beyond the Textbooks',
    description: 'The reading UPSC toppers recommend beyond standard textbooks: modern Indian history, the Constitution, foreign policy, the economy and the strategy books, for GS, the essay and the interview. Cash on delivery across India.',
    intro: 'Standard textbooks get you through Prelims. These books give your Mains answers, essay and interview the depth examiners look for: the history, polity, foreign policy and economic thinking that toppers keep recommending, grouped by paper.',
    picks: [
      { group: 'Strategy', slug: '9780143466116', name: 'Scaling Mount UPSC', by: 'Manuj Jindal', note: 'A practical guide to the whole exam, from choosing an optional to answer writing and the interview, by an officer who cleared it.' },
      { group: 'Modern Indian history (GS 1)', slug: 'india-s-struggle-for-independence-35741', name: 'India\'s Struggle for Independence', by: 'Bipan Chandra and others', note: 'The standard account of the freedom movement from 1857 to 1947. Read it alongside your notes for the depth Mains answers need.' },
      { group: 'Modern Indian history (GS 1)', slug: 'india-since-independence-paperback-bipan-chandra-paperback-b', name: 'India Since Independence', by: 'Bipan Chandra, Mridula Mukherjee, Aditya Mukherjee', note: 'Post-1947 India: integration of the states, the Constitution, the economy and politics. Directly useful for GS 1 and the essay.' },
      { group: 'Modern Indian history (GS 1)', slug: 'india-after-gandhi-the-history-of-the-world-s-largest-d-40253', name: 'India After Gandhi', by: 'Ramachandra Guha', note: 'The most readable history of independent India. Gives you examples and context that make essays and interview answers stand out.' },
      { group: 'Modern Indian history (GS 1)', slug: 'makers-of-modern-india', name: 'Makers of Modern India', by: 'Ramachandra Guha (ed.)', note: 'Writings of the thinkers who shaped India, from Rammohan Roy to Ambedkar, in their own words. A rich source of quotes for the essay.' },
      { group: 'Modern Indian history (GS 1)', slug: 'an-era-of-darkness-the-british-empire-in-india', name: 'An Era of Darkness', by: 'Shashi Tharoor', note: 'A forceful argument about the economic and social cost of British rule. Useful for colonial-economy questions and debates.' },
      { group: 'Ancient India and culture (GS 1)', slug: 'the-wonder-that-was-india-volume-i-paperback-basham-a-l-1', name: 'The Wonder That Was India', by: 'A. L. Basham', note: 'A classic survey of ancient Indian society, religion, art and literature. Ideal background for culture questions.' },
      { group: 'Ancient India and culture (GS 1)', slug: 'discovery-of-india-paperback-22685', name: 'The Discovery of India', by: 'Jawaharlal Nehru', note: 'Nehru\'s sweep through Indian history and civilisation, written in prison. Essential for understanding the ideas behind modern India.' },
      { group: 'Geography (GS 1)', slug: 'oxford-student-atlas-for-india-ce-5th-edition-for-competitiv', name: 'Oxford Student Atlas for India', by: 'Oxford University Press', note: 'The atlas most aspirants keep on their desk. Map-based Prelims questions get much easier with daily use.' },
      { group: 'Geography (GS 1)', slug: 'land-of-the-seven-rivers-pb-a-brief-history-of-indias-geogra', name: 'Land of the Seven Rivers', by: 'Sanjeev Sanyal', note: 'How India\'s rivers, mountains and coasts shaped its history. Makes geography stick by telling it as a story.' },
      { group: 'Polity and Constitution (GS 2)', slug: 'the-constitution-of-india-2', name: 'The Constitution of India', by: '', note: 'The text itself. Reading the actual articles you study is the best way to answer polity questions precisely.' },
      { group: 'Polity and Constitution (GS 2)', slug: 'bharat-ka-samvidhan-the-constitution-of-india-in-hindi-11261', name: 'Bharat Ka Samvidhan (Hindi)', by: '', note: 'The Constitution in Hindi, for Hindi-medium aspirants.' },
      { group: 'Polity and Constitution (GS 2)', slug: 'sixteen-stormy-days-the-story-of-the-first-amendment-of-the-', name: 'Sixteen Stormy Days', by: 'Tripurdaman Singh', note: 'The story of the First Amendment and the debates over free speech and property that shaped the Constitution early on.' },
      { group: 'International relations (GS 2)', slug: 'the-india-way-strategies-for-an-uncertain-world-72157', name: 'The India Way', by: 'S. Jaishankar', note: 'India\'s External Affairs Minister on how India should navigate a changing world. Frequently quoted in IR answers and interviews.' },
      { group: 'International relations (GS 2)', slug: '9789357027601', name: 'Why Bharat Matters', by: 'S. Jaishankar', note: 'The follow-up to The India Way, on India\'s foreign policy priorities today.' },
      { group: 'International relations (GS 2)', slug: 'pax-indica-india-and-the-world-in-the-21st-century-32637', name: 'Pax Indica', by: 'Shashi Tharoor', note: 'India\'s relations with its neighbours and the major powers, explained clearly. A good first book on foreign policy.' },
      { group: 'International relations (GS 2)', slug: 'choices-paperback-shivshankar-menon', name: 'Choices', by: 'Shivshankar Menon', note: 'A former National Security Adviser on five real foreign-policy decisions and why India made them. Excellent for interview depth.' },
      { group: 'Economy (GS 3)', slug: 'breaking-the-mould-reimagining-india-s-economic-future-27933', name: 'Breaking the Mould', by: 'Raghuram Rajan and Rohit Lamba', note: 'A clear, debatable vision for India\'s economic future: jobs, manufacturing, services and education. Great material for GS 3 and the essay.' },
      { group: 'Economy (GS 3)', slug: 'india-unbound-from-independence-to-the-global-information-ag', name: 'India Unbound', by: 'Gurcharan Das', note: 'India\'s economic story from independence to liberalisation, told through people and businesses.' },
      { group: 'Economy (GS 3)', slug: 'poor-economics-behavioral-economics', name: 'Poor Economics', by: 'Abhijit Banerjee and Esther Duflo', note: 'Nobel-winning economists on what actually works against poverty. Very useful for welfare and development questions.' },
    ],
    body: [
      '<h2>How to use this list</h2><p>None of these replaces the standard textbooks and NCERTs. Use them to add depth after you have covered the basics. Pick one book per paper rather than reading all of them: <em>India\'s Struggle for Independence</em> for GS 1, <em>The India Way</em> for GS 2, <em>Breaking the Mould</em> for GS 3. Read with a notebook and keep a page of examples, data and quotes for your essay and interview.</p>',
      '<h2>For the essay and the interview</h2><p>Examiners reward answers that show perspective. Books like <em>India After Gandhi</em>, <em>Makers of Modern India</em>, <em>Choices</em> and <em>Poor Economics</em> give you real examples and arguments you can use in an essay or discuss confidently in front of the board.</p>',
      '<h2>Delivery and payment</h2><p>Prepaid orders above ₹399 ship free across India, and cash on delivery is free from ₹499. Every order comes with 7-day returns and a free replacement if a copy arrives damaged.</p>',
    ],
    faq: [
      { q: 'Are these books enough to clear UPSC?', a: 'No. They add depth on top of the standard textbooks and NCERTs. Use them for Mains, the essay and the interview, once your basics are in place.' },
      { q: 'Which book is best for modern Indian history?', a: 'India\'s Struggle for Independence by Bipan Chandra and others is the standard account of the freedom movement. India After Gandhi covers the years after 1947.' },
      { q: 'Which books help with the UPSC interview?', a: 'Books that build perspective help most: The India Way and Choices for foreign policy, Breaking the Mould for the economy, and India After Gandhi for modern India.' },
      { q: 'Can I pay cash on delivery?', a: 'Yes. Cash on delivery is available across India, and it is free on orders of ₹499 or more.' },
    ],
  },
];

const DELIVERY = 'Prepaid orders above ₹399 ship free across India, and cash on delivery is free from ₹499. Every order comes with 7-day returns and a free replacement if a copy arrives damaged.';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Generated lists (utils/reading-list-agent, KV catalog:reading-lists) in the
 * shape the renderer uses. Only well-formed lists survive, and a generated list
 * never shadows a hand-written one. `status` picks published or draft lists.
 */
function storedLists(doc, { status = 'published' } = {}) {
  const taken = new Set(LISTS.map((l) => l.slug));
  const out = [];
  for (const l of (doc && Array.isArray(doc.lists) ? doc.lists : [])) {
    if (!l || l.status !== status || !SLUG_RE.test(String(l.slug || '')) || taken.has(l.slug)) continue;
    const picks = (Array.isArray(l.picks) ? l.picks : []).filter((p) => p && /^[\w-]{1,200}$/.test(String(p.slug || '')));
    if (picks.length < 3) continue;
    taken.add(l.slug);
    out.push({
      slug: l.slug, generated: true, preview_token: l.preview_token || '',
      title: String(l.title || ''), h1: String(l.h1 || l.title || ''), description: String(l.description || ''),
      intro: String(l.intro || ''), maxPrice: Number(l.maxPrice) > 0 ? Number(l.maxPrice) : undefined,
      picks: picks.map((p) => ({ slug: String(p.slug), name: String(p.name || ''), by: String(p.by || ''), note: String(p.note || ''), group: p.group ? String(p.group) : undefined })),
      body: (Array.isArray(l.body) ? l.body : []).filter((b) => b && b.heading && b.text).map((b) => ({ heading: String(b.heading), text: String(b.text) })),
      faq: (Array.isArray(l.faq) ? l.faq : []).filter((f) => f && f.q && f.a).map((f) => ({ q: String(f.q), a: String(f.a) })),
    });
  }
  return out;
}

/** Hand-written lists first, then published generated ones. */
function allLists(doc) { return [...LISTS, ...storedLists(doc)]; }

const listFor = (slug, lists = LISTS) => lists.find((l) => l.slug === String(slug || '').toLowerCase()) || null;
const urlOf = (list) => `${BASE}${list.slug}/`;

/** Every list that features this product slug (for "Featured in" on product pages). */
function listsFeaturing(productSlug, lists = LISTS) {
  const s = String(productSlug || '').toLowerCase();
  return lists.filter((l) => l.picks.some((p) => p.slug.toLowerCase() === s));
}

/** Every product slug the lists need, for one batched read (`perList` caps each list, for the index). */
function allPickSlugs(lists = LISTS, { perList = Infinity } = {}) {
  return [...new Set(lists.flatMap((l) => l.picks.slice(0, perList).map((p) => p.slug.toLowerCase())))];
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rupees = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');

/**
 * Which picks to show, in list order: the books the till priced, within budget.
 * `books` maps a lower-case slug to { price, mrp, img, title, author }.
 */
function shownPicks(list, books) {
  const out = [];
  for (const p of list.picks) {
    const b = books[p.slug.toLowerCase()];
    if (!b || !(Number(b.price) > 0)) continue;
    if (list.maxPrice && Number(b.price) > list.maxPrice) continue;
    // Generated lists credit only the author the agent checked: the catalogue
    // author field is sometimes a shelf label ("Crossword Recommends", "Various").
    out.push({ ...p, ...b, name: p.name || b.title, by: p.by || (list.generated ? '' : b.author || '') });
  }
  return out;
}

const STYLE = `<style>
.rl-list{list-style:none;margin:1.6rem 0;padding:0;display:grid;gap:1rem}
.rl-item{display:grid;grid-template-columns:96px 1fr;gap:1rem;padding:1rem;border:1px solid var(--border,#e5e0d8);border-radius:6px;align-items:start}
.rl-cover img{width:96px;height:auto;display:block;border-radius:3px}
.rl-item h3{margin:0 0 .2rem;font-size:1.05rem;line-height:1.3}
.rl-item h3 a{color:inherit;text-decoration:none}
.rl-by{margin:0 0 .45rem;font-size:.85rem;color:var(--muted,#6b6b6b)}
.rl-note{margin:0 0 .6rem;font-size:.95rem;line-height:1.55}
.rl-buy{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;font-size:.95rem}
.rl-buy s{color:var(--muted,#6b6b6b);font-size:.85rem}
.rl-btn{display:inline-block;padding:.4rem .9rem;border:1px solid var(--gold,#b8860b);color:var(--gold,#b8860b);font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;border-radius:3px}
.rl-group{margin:2rem 0 .2rem;font-size:1.25rem}
.rl-faq dt{font-weight:600;margin-top:1rem}
.rl-faq dd{margin:.3rem 0 0}
.rl-more{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}
.rl-more a{display:inline-block;padding:.45rem .9rem;border:1px solid var(--border,#e5e0d8);font-size:.85rem;text-decoration:none;color:inherit;border-radius:3px}
.rl-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem;margin-top:1.6rem}
.rl-card{display:block;padding:1.1rem;border:1px solid var(--border,#e5e0d8);border-radius:6px;text-decoration:none;color:inherit}
.rl-card strong{display:block;font-size:1.05rem;margin-bottom:.4rem}
.rl-card .rl-covers{display:flex;gap:.3rem;margin-bottom:.7rem;min-height:1px}
.rl-card .rl-covers img{width:52px;height:auto;border-radius:2px}
@media (max-width:520px){.rl-item{grid-template-columns:72px 1fr}.rl-cover img{width:72px}}
</style>`;

const TRUST = `<div class="trust">
    <span>🚚 Delivery in 2-5 days</span>
    <span>💵 Cash on delivery</span>
    <span>💳 UPI · Cards · Net banking</span>
    <span>🛡 <a href="/return-policy/" style="color:inherit">7-day returns and free replacement</a></span>
  </div>`;

function itemHtml(b, n) {
  const href = `/product/${encodeURIComponent(b.slug)}/`;
  const mrp = Number(b.mrp) > Number(b.price) ? ` <s>${rupees(b.mrp)}</s>` : '';
  return `<li class="rl-item" id="book-${n}">
      <a class="rl-cover" href="${href}">${b.img ? `<img src="${esc(b.img)}" alt="${esc(b.name)} cover" loading="lazy" onerror="this.style.display='none'"/>` : ''}</a>
      <div>
        <h3><a href="${href}">${n}. ${esc(b.name)}</a></h3>
        ${b.by ? `<p class="rl-by">by ${esc(b.by)}</p>` : ''}
        <p class="rl-note">${esc(b.note)}</p>
        <p class="rl-buy"><b>${rupees(b.price)}</b>${mrp}<a class="rl-btn" href="${href}">View book</a></p>
      </div>
    </li>`;
}

/** Up to 8 other lists: hand-written ones first, then the newest generated ones. */
function moreLinks(current, lists = LISTS) {
  const others = lists.filter((l) => l.slug !== current);
  const pick = [...others.filter((l) => !l.generated), ...others.filter((l) => l.generated).reverse()].slice(0, 8);
  return `<h2>More reading lists</h2><nav class="rl-more" aria-label="More reading lists">${
    pick.map((l) => `<a href="${urlOf(l)}">${esc(l.h1)}</a>`).join('')
  }<a href="${BASE}">All reading lists</a><a href="/bestsellers/">Best sellers</a></nav>`;
}

/** Hand-written copy is trusted HTML; generated copy is plain text and escaped. */
function introHtml(list) { return list.generated ? esc(list.intro) : list.intro; }
function bodyHtml(list) {
  if (!list.generated) return (list.body || []).join('\n');
  return [...(list.body || []).map((b) => `<h2>${esc(b.heading)}</h2><p>${esc(b.text)}</p>`),
    `<h2>Delivery and payment</h2><p>${DELIVERY}</p>`].join('\n');
}

/** Everything the Worker writes into the page shell for one list. */
function renderList(list, books, lists = LISTS) {
  const shown = shownPicks(list, books);
  const canonical = `${SITE}${urlOf(list)}`;
  let n = 0;
  let lastGroup = null;
  const items = [];
  for (const b of shown) {
    if (b.group && b.group !== lastGroup) {
      if (items.length) items.push('</ol>');
      items.push(`<h2 class="rl-group">${esc(b.group)}</h2><ol class="rl-list">`);
      lastGroup = b.group;
    } else if (!items.length) {
      items.push('<ol class="rl-list">');
    }
    n += 1;
    items.push(itemHtml(b, n));
  }
  if (items.length) items.push('</ol>');
  const faq = (list.faq || []).length
    ? `<h2>Frequently asked questions</h2><dl class="rl-faq">${list.faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join('')}</dl>`
    : '';
  const main = `${STYLE}
  <div class="crumb"><a href="/">Home</a> / <a href="${BASE}">Reading lists</a> / ${esc(list.h1)}</div>
  <h1>${esc(list.h1)}</h1>
  <p class="intro">${introHtml(list)}</p>
  ${TRUST}
  ${items.join('\n')}
  <div class="body-copy">${bodyHtml(list)}${faq}${moreLinks(list.slug, lists)}</div>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList', name: list.h1, numberOfItems: shown.length,
        itemListElement: shown.map((b, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/product/${encodeURIComponent(b.slug)}/`, name: b.name })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Reading lists', item: `${SITE}${BASE}` },
          { '@type': 'ListItem', position: 3, name: list.h1, item: canonical },
        ],
      },
      ...((list.faq || []).length ? [{
        '@type': 'FAQPage',
        mainEntity: list.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      }] : []),
    ],
  };
  return {
    title: `${list.title} | Ink & Chai`,
    ogTitle: list.title,
    description: list.description,
    canonical,
    image: (shown.find((b) => b.img) || {}).img || '',
    main,
    jsonLd: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
    count: shown.length,
  };
}

/** The /best-books/ index: one card per list with a few covers. */
function renderIndex(books, lists = LISTS) {
  const canonical = `${SITE}${BASE}`;
  const ordered = [...lists.filter((l) => !l.generated), ...lists.filter((l) => l.generated).reverse()];
  const cards = ordered.map((l) => {
    const shown = shownPicks(l, books);
    const covers = shown.filter((b) => b.img).slice(0, 4)
      .map((b) => `<img src="${esc(b.img)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`).join('');
    return `<a class="rl-card" href="${urlOf(l)}"><span class="rl-covers">${covers}</span><strong>${esc(l.h1)}</strong><span>${esc(stripTags(l.description).slice(0, 140))}…</span></a>`;
  }).join('');
  const main = `${STYLE}
  <div class="crumb"><a href="/">Home</a> / Reading lists</div>
  <h1>Reading Lists</h1>
  <p class="intro">Hand-picked book lists from the Ink &amp; Chai team: what to read next, by mood, budget and goal. Every book is in stock at the price shown.</p>
  ${TRUST}
  <div class="rl-cards">${cards}</div>
  <div class="body-copy"><h2>Looking for something else?</h2><nav class="rl-more"><a href="/bestsellers/">Best sellers</a><a href="/booktok-bestsellers/">BookTok bestsellers</a><a href="/best-romance-books-india/">Romance</a><a href="/best-self-help-books-india/">Self-help</a><a href="/best-hindi-books/">Hindi books</a><a href="/books-under-299/">Books under ₹299</a></nav></div>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList', name: 'Reading lists', numberOfItems: ordered.length,
    itemListElement: ordered.map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}${urlOf(l)}`, name: l.h1 })),
  };
  return {
    title: 'Reading Lists: Hand-Picked Books to Read Next | Ink & Chai',
    ogTitle: 'Reading Lists: Hand-Picked Books to Read Next',
    description: 'Hand-picked book lists from Ink & Chai: thrillers under ₹300, books like It Ends With Us, reading for UPSC aspirants and more. Cash on delivery across India.',
    canonical,
    image: '',
    main,
    jsonLd: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
    count: ordered.length,
  };
}

/** The "Featured in" line on a product page, or '' when no list has the book (at most 3 lists). */
function featuredInHtml(productSlug, lists = LISTS) {
  const found = listsFeaturing(productSlug, lists).slice(0, 3);
  if (!found.length) return '';
  return `<p class="rl-featured" style="margin:1rem 0;font-size:.9rem;">📚 Featured in: ${
    found.map((l) => `<a href="${urlOf(l)}" style="color:var(--gold,#b8860b);">${esc(l.h1)}</a>`).join(' · ')
  }</p>`;
}

/** Sitemap entries for the lists and the index. */
function sitemapUrls(lists = LISTS) {
  return [`${SITE}${BASE}`, ...lists.map((l) => `${SITE}${urlOf(l)}`)];
}

/** sitemap.xml with the reading-list URLs added (each once). */
function addToSitemap(xml, lists = LISTS) {
  const s = String(xml || '');
  const end = s.lastIndexOf('</urlset>');
  if (end < 0) return { xml: s, added: 0 };
  const lines = sitemapUrls(lists).filter((u) => !s.includes(`<loc>${u}</loc>`))
    .map((u) => `  <url><loc>${u}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  if (!lines.length) return { xml: s, added: 0 };
  return { xml: `${s.slice(0, end)}${lines.join('\n')}\n${s.slice(end)}`, added: lines.length };
}

module.exports = {
  LISTS, BASE, SLUG_RE, listFor, urlOf, listsFeaturing, allPickSlugs, shownPicks, storedLists, allLists,
  renderList, renderIndex, featuredInHtml, sitemapUrls, addToSitemap,
};
