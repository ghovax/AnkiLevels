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

// IndexedDB helper class
class AnkiDB {
  private dbName = "AnkiLevelsDB";
  private storeName = "words";
  private version = 1;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "word" });
        }
      };
    });
  }

  async saveWords(
    words: Map<string, { difficultyLevel: number }>,
  ): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);

      // Clear existing data
      store.clear();

      // Add all words
      words.forEach((data, word) => {
        store.put({ word, difficultyLevel: data.difficultyLevel });
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getWords(): Promise<Map<string, { difficultyLevel: number }> | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result;
        if (results.length === 0) {
          resolve(null);
        } else {
          const wordMap = new Map<string, { difficultyLevel: number }>();
          results.forEach((item: any) => {
            wordMap.set(item.word, { difficultyLevel: item.difficultyLevel });
          });
          resolve(wordMap);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveMetadata(key: string, value: any): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      store.put({ word: `__metadata_${key}`, value });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getMetadata(key: string): Promise<any> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(`__metadata_${key}`);

      request.onsuccess = () => {
        resolve(request.result?.value);
      };
      request.onerror = () => reject(request.error);
    });
  }
}

async function callAnkiConnect(action: string, params: any = {}): Promise<any> {
  const response = await fetch("http://localhost:8765", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });

  const data: AnkiConnectResponse = await response.json();
  if (data.error) {
    throw new Error(`AnkiConnect error: ${data.error}`);
  }
  return data.result;
}

async function fetchJapaneseCards(): Promise<
  Map<string, { difficultyLevel: number }>
> {
  try {
    // Get deck name from storage
    const storage = await browser.storage.local.get("deckName");
    const deckName = storage.deckName || "Japanese";

    // Find all cards in the specified deck
    const cardIds = await callAnkiConnect("findCards", {
      query: `deck:${deckName}`,
    });

    if (!cardIds || cardIds.length === 0) {
      return new Map();
    }

    // Batch card info requests to reduce latency
    const BATCH_SIZE = 500;
    const batches: number[][] = [];
    for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
      batches.push(cardIds.slice(i, i + BATCH_SIZE));
    }

    // Process batches in parallel (max 5 concurrent requests)
    const MAX_CONCURRENT = 5;
    const allCardsInfo: any[] = [];

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        batchGroup.map((batch) =>
          callAnkiConnect("cardsInfo", { cards: batch }),
        ),
      );
      results.forEach((result) => allCardsInfo.push(...result));
    }

    const wordMap = new Map<string, { difficultyLevel: number }>();

    allCardsInfo.forEach((card) => {
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
    console.error("Error fetching Anki cards:", error);
    return new Map();
  }
}

const db = new AnkiDB();
let cachedWords: Map<string, { difficultyLevel: number }> | null = null;
let isSyncing = false;
const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function syncWithAnki() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    console.log("Syncing with Anki...");
    const words = await fetchJapaneseCards();
    cachedWords = words;
    await db.saveWords(words);
    await db.saveMetadata("lastSync", Date.now());
    console.log(`Synced ${words.size} words from Anki`);
  } catch (error) {
    console.error("Error syncing with Anki:", error);
  } finally {
    isSyncing = false;
  }
}

export default defineBackground(() => {
  // Initialize database and load cached words
  db.init().then(async () => {
    // Try to load from IndexedDB first (instant)
    const savedWords = await db.getWords();
    if (savedWords) {
      cachedWords = savedWords;
      console.log(`Loaded ${savedWords.size} words from IndexedDB`);
    }

    // Check if we need to sync
    const lastSync = await db.getMetadata("lastSync");
    const now = Date.now();

    if (!lastSync || now - lastSync > SYNC_INTERVAL) {
      // Sync in background
      syncWithAnki();
    }

    // Set up periodic sync every 24 hours
    setInterval(() => {
      syncWithAnki();
    }, SYNC_INTERVAL);
  });

  // Listen for requests from content script
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "getWords") {
      // Return cached words immediately if available
      if (cachedWords) {
        sendResponse({ words: Array.from(cachedWords.entries()) });
      } else {
        // If no cache, wait for DB to load
        db.getWords().then((words) => {
          if (words) {
            cachedWords = words;
            sendResponse({ words: Array.from(words.entries()) });
          } else {
            // No data yet, trigger sync
            syncWithAnki().then(() => {
              if (cachedWords) {
                sendResponse({ words: Array.from(cachedWords.entries()) });
              } else {
                sendResponse({ words: [] });
              }
            });
          }
        });
        return true; // Keep channel open for async response
      }
    }

    if (message.action === "refreshWords") {
      // Force sync with Anki
      syncWithAnki().then(() => {
        if (cachedWords) {
          sendResponse({
            words: Array.from(cachedWords.entries()),
            count: cachedWords.size,
          });
        } else {
          sendResponse({ words: [], count: 0 });
        }
      });
      return true; // Keep channel open for async response
    }
  });
});
