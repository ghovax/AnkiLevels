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
    // Get deck name from storage
    const storage = await browser.storage.local.get('deckName');
    const deckName = storage.deckName || 'Japanese';

    // Find all cards in the specified deck
    const cardIds = await callAnkiConnect('findCards', { query: `deck:${deckName}` });

    if (!cardIds || cardIds.length === 0) {
      return new Map();
    }

    // Get detailed information about the cards
    const cardsInfo: any[] = await callAnkiConnect('cardsInfo', { cards: cardIds });

    const wordMap = new Map<string, { difficultyLevel: number }>();

    cardsInfo.forEach((card) => {
      const expression = card.fields?.Expression?.value;
      if (!expression) return;

      // Calculate difficulty level (0-100) based on card stats
      // Higher interval = easier (better known)
      // More lapses = harder
      const interval = card.interval || 0;
      const lapses = card.lapses || 0;
      const reps = card.reps || 0;

      // Base score from interval (most important factor)
      // 1 day = 10 points, 21 days (3 weeks) = 50 points, 90 days (3 months) = 75 points, 180+ days = 90+ points
      let intervalScore = 0;
      if (interval >= 180) {
        intervalScore = 90 + Math.min((interval - 180) / 365, 1) * 10; // 90-100 for 6+ months
      } else if (interval >= 90) {
        intervalScore = 75 + ((interval - 90) / 90) * 15; // 75-90 for 3-6 months
      } else if (interval >= 21) {
        intervalScore = 50 + ((interval - 21) / 69) * 25; // 50-75 for 3 weeks to 3 months
      } else if (interval >= 7) {
        intervalScore = 30 + ((interval - 7) / 14) * 20; // 30-50 for 1-3 weeks
      } else if (interval >= 1) {
        intervalScore = 10 + ((interval - 1) / 6) * 20; // 10-30 for 1-7 days
      } else {
        intervalScore = 0; // New card
      }

      // Lapses penalty: small penalty for mistakes (not too harsh)
      // 0 lapses = 0 penalty, 1-2 lapses = -5 to -10, 3+ lapses = -15+
      const lapsesScore = -Math.min(lapses * 5, 25);

      // Bonus for cards with any reviews (you've seen it at least)
      const repsBonus = reps > 0 ? Math.min(reps * 2, 10) : 0;

      let difficultyLevel = intervalScore + lapsesScore + repsBonus;
      difficultyLevel = Math.max(0, Math.min(100, difficultyLevel));

      wordMap.set(expression, { difficultyLevel: difficultyLevel });
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
  // Fetch cards on startup
  fetchJapaneseCards().then((words) => {
    cachedWords = words;
    lastFetchTime = Date.now();
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
