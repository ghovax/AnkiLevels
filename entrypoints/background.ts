interface AnkiCard {
  cardId: number;
  fields: {
    Expression?: { value: string };
    [key: string]: { value: string } | undefined;
  };
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
}

interface AnkiConnectResponse {
  result: any;
  error: string | null;
}

async function callAnkiConnect(action: string, params: any = {}): Promise<any> {
  const response = await fetch('http://localhost:8765', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });

  const data: AnkiConnectResponse = await response.json();
  if (data.error) {
    throw new Error(`AnkiConnect error: ${data.error}`);
  }
  return data.result;
}

async function fetchJapaneseCards(): Promise<Map<string, { difficultyLevel: number }>> {
  try {
    // Find all cards in the Japanese deck
    const cardIds = await callAnkiConnect('findCards', { query: 'deck:Japanese' });

    if (!cardIds || cardIds.length === 0) {
      console.log('No cards found in Japanese deck');
      return new Map();
    }

    // Get detailed information about the cards
    const cardsInfo: AnkiCard[] = await callAnkiConnect('cardsInfo', { cards: cardIds });

    const wordMap = new Map<string, { difficultyLevel: number }>();

    cardsInfo.forEach((card) => {
      const expression = card.fields.Expression?.value;
      if (!expression) return;

      // Calculate difficulty level (0-100) based on card stats
      // Lower interval = harder (less known)
      // More lapses = harder
      // Lower ease = harder
      const intervalScore = Math.min(card.interval / 365, 1) * 40; // Max 40 points for 1 year interval
      const easeScore = ((card.ease - 1300) / 1700) * 30; // Ease typically 1300-3000, max 30 points
      const lapsesScore = Math.max(30 - (card.lapses * 5), 0); // Fewer lapses = higher score, max 30 points

      const difficultyLevel = Math.max(0, Math.min(100, intervalScore + easeScore + lapsesScore));

      wordMap.set(expression, { difficultyLevel });
    });

    return wordMap;
  } catch (error) {
    console.error('Error fetching Anki cards:', error);
    return new Map();
  }
}

let cachedWords: Map<string, { difficultyLevel: number }> | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export default defineBackground(() => {
  console.log('AnkiLevels background script started');

  // Fetch cards on startup
  fetchJapaneseCards().then((words) => {
    cachedWords = words;
    lastFetchTime = Date.now();
    console.log(`Fetched ${words.size} words from Japanese deck`);
  });

  // Listen for requests from content script
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'getWords') {
      const now = Date.now();

      // Refresh cache if expired
      if (!cachedWords || now - lastFetchTime > CACHE_DURATION) {
        fetchJapaneseCards().then((words) => {
          cachedWords = words;
          lastFetchTime = now;
          sendResponse({ words: Array.from(words.entries()) });
        });
        return true; // Keep channel open for async response
      } else {
        sendResponse({ words: Array.from(cachedWords.entries()) });
      }
    }

    if (message.action === 'refreshWords') {
      fetchJapaneseCards().then((words) => {
        cachedWords = words;
        lastFetchTime = Date.now();
        sendResponse({ words: Array.from(words.entries()), count: words.size });
      });
      return true; // Keep channel open for async response
    }
  });
});
