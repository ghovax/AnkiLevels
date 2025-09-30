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

    // Request words from background script
    browser.runtime.sendMessage({ action: 'getWords' }).then((response) => {
      if (response && response.words) {
        wordsMap = new Map(response.words);
        // Wait for DOM to be ready before highlighting
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', highlightWords);
        } else {
          // DOM already loaded, highlight immediately with a small delay to ensure rendering
          setTimeout(highlightWords, 100);
        }
      }
    });

    function highlightWords() {
      if (wordsMap.size === 0) return;

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

      // Process in batches to avoid blocking
      let processed = 0;
      const batchSize = 100;

      function processBatch() {
        const end = Math.min(processed + batchSize, textNodes.length);

        for (let i = processed; i < end; i++) {
          const textNode = textNodes[i];
          const text = textNode.textContent || '';
          if (!text.trim()) continue;

          const matches: { index: number; length: number; data: WordData; word: string }[] = [];

          // Only search for words, much more efficient than forEach on all 17k words
          for (const [word, data] of sortedWords) {
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
          requestAnimationFrame(processBatch);
        }
      }

      processBatch();
    }

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

      if (shouldHighlight) {
        setTimeout(highlightWords, 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  },
});
