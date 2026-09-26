// Real people most often targeted by fake sexual images, lowercase. rules.mjs refuses any sexual
// prompt that names one of them, in any case and at any position; the text models in screen.mjs
// catch everyone else. Not exhaustive; add names as needed.

/** Surnames and single names that on their own point at one of them ("nude Trump"). */
export const FAMOUS_SHORT = [
  'trump', 'obama', 'biden', 'kamala', 'melania', 'ivanka', 'hillary', 'pelosi', 'putin', 'zelensky', 'macron', 'trudeau', 'musk',
  'zuckerberg', 'bezos', 'kardashian', 'kardashians', 'jenner', 'hadid', 'swift', 'beyonce', 'rihanna', 'zendaya', 'shakira', 'madonna',
  'adele', 'lizzo', 'eilish', 'ariana', 'bieber', 'ratajkowski', 'pokimane', 'amouranth', 'ronaldo', 'messi', 'lebron', 'kelce',
  'thunberg', 'markle', 'middleton', 'johansson', 'ortega', 'sweeney', 'robbie', 'gadot', 'jolie', 'aniston', 'minaj', 'cardi',
];

export const FAMOUS = [
  // music
  'taylor swift', 'beyonce', 'beyoncé', 'rihanna', 'ariana grande', 'billie eilish', 'selena gomez', 'dua lipa', 'lady gaga',
  'katy perry', 'miley cyrus', 'nicki minaj', 'cardi b', 'doja cat', 'megan thee stallion', 'shakira', 'jennifer lopez', 'j lo',
  'madonna', 'britney spears', 'christina aguilera', 'olivia rodrigo', 'sabrina carpenter', 'ice spice', 'lizzo', 'sza', 'adele',
  'demi lovato', 'camila cabello', 'justin bieber', 'harry styles', 'the weeknd', 'kanye west', 'travis scott',
  'bad bunny', 'karol g', 'lisa blackpink', 'jennie kim', 'jisoo', 'rosé', 'jungkook', 'bts', 'blackpink', 'newjeans',
  // film and tv
  'scarlett johansson', 'emma watson', 'emma stone', 'margot robbie', 'zendaya', 'jennifer lawrence', 'jennifer aniston',
  'angelina jolie', 'gal gadot', 'natalie portman', 'anne hathaway', 'sydney sweeney', 'jenna ortega', 'millie bobby brown',
  'florence pugh', 'anya taylor-joy', 'ana de armas', 'megan fox', 'kate upton', 'emilia clarke', 'sophie turner', 'maisie williams',
  'elizabeth olsen', 'brie larson', 'zoe saldana', 'salma hayek', 'sofia vergara', 'kate winslet', 'keira knightley', 'mila kunis',
  'kristen stewart', 'dakota johnson', 'olivia wilde', 'blake lively', 'priyanka chopra', 'deepika padukone', 'alia bhatt',
  'katrina kaif', 'tom cruise', 'brad pitt', 'leonardo dicaprio', 'johnny depp', 'dwayne johnson', 'keanu reeves',
  'chris hemsworth', 'chris evans', 'ryan reynolds', 'timothee chalamet', 'timothée chalamet', 'tom holland', 'henry cavill',
  'jenna coleman', 'charli damelio', 'addison rae', 'dixie damelio', 'bella poarch',
  // reality tv, models and influencers
  'kim kardashian', 'khloe kardashian', 'kourtney kardashian', 'kylie jenner', 'kendall jenner', 'paris hilton', 'bella hadid',
  'gigi hadid', 'hailey bieber', 'emily ratajkowski', 'pokimane', 'amouranth', 'belle delphine', 'corinna kopf', 'valkyrae',
  'mrbeast', 'logan paul', 'jake paul', 'andrew tate', 'ishowspeed', 'kai cenat', 'xqc',
  // sport
  'serena williams', 'naomi osaka', 'simone biles', 'alex morgan', 'megan rapinoe', 'caitlin clark', 'livvy dunne',
  'olivia dunne', 'cristiano ronaldo', 'lionel messi', 'lebron james', 'tom brady', 'travis kelce', 'conor mcgregor',
  // politics, business and royals
  'donald trump', 'melania trump', 'ivanka trump', 'joe biden', 'jill biden', 'kamala harris', 'barack obama', 'michelle obama',
  'hillary clinton', 'alexandria ocasio-cortez', 'aoc', 'nancy pelosi', 'vladimir putin', 'volodymyr zelensky', 'xi jinping',
  'narendra modi', 'justin trudeau', 'emmanuel macron', 'giorgia meloni', 'rishi sunak', 'keir starmer', 'king charles',
  'prince william', 'kate middleton', 'princess kate', 'prince harry', 'meghan markle', 'elon musk', 'mark zuckerberg',
  'jeff bezos', 'bill gates', 'sam altman', 'vitalik buterin', 'changpeng zhao', 'cz binance', 'sam bankman-fried', 'greta thunberg',
];
