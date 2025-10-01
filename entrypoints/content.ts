interface WordData {
  difficultyLevel: number;
}

function getDifficultyColor(level: number): string {
  // level: 0 (red/hard) to 100 (green/easy)
  // Red: rgb(255, 0, 0) -> Green: rgb(0, 255, 0)
  const red = Math.round(255 * (1 - level / 100));
  const green = Math.round(255 * (level / 100));
  return `rgb(${red}, ${green}, 0)`;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    let wordsMap: Map<string, WordData> = new Map();
    let isHighlighting = false;

    // Create status indicator
    const statusDiv = document.createElement('div');
    statusDiv.id = 'anki-levels-status';
    statusDiv.style.cssText = 'position: fixed; top: 10px; left: 10px; background: rgba(0,0,0,0.8); color: white; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; z-index: 999999; display: none;';
    document.documentElement.appendChild(statusDiv);

    function showStatus(message: string) {
      statusDiv.textContent = message;
      statusDiv.style.display = 'block';
    }

    function hideStatus() {
      statusDiv.style.display = 'none';
    }

    // Request words from background script
    const startTime = Date.now();
    showStatus('Loading words...');

    browser.runtime.sendMessage({ action: 'getWords' }).then((response) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (response && response.words) {
        wordsMap = new Map(response.words);
        showStatus(`Loaded ${wordsMap.size} words (${elapsed}s)`);

        // Wait for DOM to be ready before highlighting
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => highlightWords(false));
        } else {
          // DOM already loaded, schedule highlighting with idle callback
          requestIdleCallback(() => highlightWords(false), { timeout: 500 });
        }

        // Hide status after 2 seconds
        setTimeout(hideStatus, 2000);
      } else {
        showStatus('Failed to load words');
        setTimeout(hideStatus, 3000);
      }
    }).catch((error) => {
      showStatus(`Error: ${error.message}`);
      setTimeout(hideStatus, 3000);
    });

    function highlightWords(skipCheck: boolean = true) {
      if (isHighlighting || wordsMap.size === 0) return;
      if (!skipCheck) isHighlighting = true;

      // Sort words by length (longest first) for better matching
      const sortedWords = Array.from(wordsMap.entries()).sort((a, b) => b[0].length - a[0].length);

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tagName = parent.tagName;
            // Skip script, style, textarea, input, and already highlighted nodes
            if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'TEXTAREA' || tagName === 'INPUT' || tagName === 'NOSCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.classList.contains('anki-highlight')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      const textNodes: Text[] = [];
      let node;
      while ((node = walker.nextNode())) {
        textNodes.push(node as Text);
      }

      // Process in smaller batches with idle callbacks to avoid blocking
      let processed = 0;
      const batchSize = 50;

      function processBatch() {
        const end = Math.min(processed + batchSize, textNodes.length);
        const deadline = performance.now() + 8; // Max 8ms per batch

        for (let i = processed; i < end; i++) {
          // Check if we're running out of time
          if (performance.now() >= deadline) {
            break;
          }

          const textNode = textNodes[i];
          const text = textNode.textContent || '';
          if (!text.trim()) continue;

          const matches: { index: number; length: number; data: WordData; word: string }[] = [];

          // Only search for words that could potentially match
          for (const [word, data] of sortedWords) {
            // Quick check: if word isn't in text, skip
            if (!text.includes(word)) continue;
            let index = text.indexOf(word);
            while (index !== -1) {
              // Check if this position is already covered by a longer match
              const isCovered = matches.some(
                (m) => index >= m.index && index < m.index + m.length
              );

              if (!isCovered) {
                matches.push({ index, length: word.length, data, word });
              }

              index = text.indexOf(word, index + 1);
            }
          }

          if (matches.length === 0) continue;

          // Sort by position and remove overlaps (keep longest/first match)
          matches.sort((a, b) => {
            if (a.index !== b.index) return a.index - b.index;
            return b.length - a.length; // Prefer longer matches at same position
          });

          const finalMatches: typeof matches = [];
          for (const match of matches) {
            const hasOverlap = finalMatches.some(
              (existing) =>
                (match.index >= existing.index && match.index < existing.index + existing.length) ||
                (match.index + match.length > existing.index && match.index < existing.index)
            );

            if (!hasOverlap) {
                finalMatches.push(match);
            }
          }

          if (finalMatches.length === 0) continue;

          // Build replacement fragment
          const fragment = document.createDocumentFragment();
          let lastIndex = 0;

          for (const match of finalMatches) {
            // Add text before match
            if (match.index > lastIndex) {
              fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
            }

            // Add highlighted span
            const span = document.createElement('span');
            span.className = 'anki-highlight';
            span.textContent = match.word;
            const color = getDifficultyColor(match.data.difficultyLevel);
            // Set styles individually to ensure they're applied
            span.style.setProperty('display', 'inline', 'important');
            span.style.setProperty('background-color', `${color}33`, 'important');
            span.style.setProperty('text-decoration', `underline 2px solid ${color}`, 'important');
            span.style.setProperty('text-underline-offset', '2px', 'important');
            span.style.setProperty('cursor', 'pointer', 'important');
            span.style.setProperty('transition', 'background-color 0.2s', 'important');
            // Prevent font size inheritance issues
            span.style.setProperty('font-size', 'inherit', 'important');
            span.style.setProperty('font-family', 'inherit', 'important');
            span.style.setProperty('font-weight', 'inherit', 'important');
            span.style.setProperty('line-height', 'inherit', 'important');
            span.title = `${Math.round(match.data.difficultyLevel)}%`;

            fragment.appendChild(span);
            lastIndex = match.index + match.length;
          }

          // Add remaining text
          if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
          }

          textNode.parentNode?.replaceChild(fragment, textNode);
        }

        processed = end;

        if (processed < textNodes.length) {
          // Use requestIdleCallback for better performance
          if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(processBatch, { timeout: 1000 });
          } else {
            requestAnimationFrame(processBatch);
          }
        } else {
          isHighlighting = false;
        }
      }

      processBatch();
    }

    // Debounce helper
    let mutationTimeout: number | null = null;

    // Re-highlight when DOM changes (for dynamic content)
    const observer = new MutationObserver((mutations) => {
      let shouldHighlight = false;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            shouldHighlight = true;
          }
        });
      });

      if (shouldHighlight && !isHighlighting) {
        // Debounce to avoid excessive re-highlighting
        if (mutationTimeout !== null) {
          clearTimeout(mutationTimeout);
        }
        mutationTimeout = setTimeout(() => {
          highlightWords(true);
          mutationTimeout = null;
        }, 300) as unknown as number;
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  },
});
