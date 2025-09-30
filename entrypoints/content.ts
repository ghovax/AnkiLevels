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
    console.log('AnkiLevels content script loaded');

    let wordsMap: Map<string, WordData> = new Map();

    // Request words from background script
    browser.runtime.sendMessage({ action: 'getWords' }).then((response) => {
      if (response && response.words) {
        wordsMap = new Map(response.words);
        console.log(`Loaded ${wordsMap.size} words for highlighting`);
        highlightWords();
      }
    });

    function highlightWords() {
      if (wordsMap.size === 0) return;

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip script, style, and already processed nodes
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') {
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

      textNodes.forEach((textNode) => {
        const text = textNode.textContent || '';
        if (!text.trim()) return;

        const matches: { index: number; length: number; data: WordData }[] = [];

        // Find all matching words in the text
        wordsMap.forEach((data, word) => {
          let index = 0;
          while ((index = text.indexOf(word, index)) !== -1) {
            matches.push({ index, length: word.length, data });
            index += word.length;
          }
        });

        if (matches.length === 0) return;

        // Sort matches by position and handle overlaps (keep shortest match)
        matches.sort((a, b) => a.index - b.index);

        const nonOverlappingMatches: typeof matches = [];
        matches.forEach((match) => {
          const hasOverlap = nonOverlappingMatches.some((existing) => {
            return (
              (match.index >= existing.index && match.index < existing.index + existing.length) ||
              (match.index + match.length > existing.index &&
                match.index + match.length <= existing.index + existing.length) ||
              (match.index <= existing.index && match.index + match.length >= existing.index + existing.length)
            );
          });

          if (!hasOverlap) {
            nonOverlappingMatches.push(match);
          } else {
            // If there's overlap, keep the shorter match
            const overlappingIndex = nonOverlappingMatches.findIndex((existing) => {
              return (
                (match.index >= existing.index && match.index < existing.index + existing.length) ||
                (match.index + match.length > existing.index &&
                  match.index + match.length <= existing.index + existing.length) ||
                (match.index <= existing.index && match.index + match.length >= existing.index + existing.length)
              );
            });

            if (overlappingIndex !== -1 && match.length < nonOverlappingMatches[overlappingIndex].length) {
              nonOverlappingMatches[overlappingIndex] = match;
            }
          }
        });

        // Replace text node with highlighted spans
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        nonOverlappingMatches
          .sort((a, b) => a.index - b.index)
          .forEach((match) => {
            // Add text before match
            if (match.index > lastIndex) {
              fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
            }

            // Add highlighted span
            const span = document.createElement('span');
            span.className = 'anki-highlight';
            span.textContent = text.substring(match.index, match.index + match.length);
            span.style.cssText = `
              background-color: ${getDifficultyColor(match.data.difficultyLevel)}33 !important;
              border-bottom: 2px solid ${getDifficultyColor(match.data.difficultyLevel)} !important;
              cursor: pointer !important;
              transition: background-color 0.2s !important;
            `;

            // Add tooltip on hover
            span.title = `Difficulty: ${Math.round(match.data.difficultyLevel)}/100`;

            fragment.appendChild(span);
            lastIndex = match.index + match.length;
          });

        // Add remaining text
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }

        textNode.parentNode?.replaceChild(fragment, textNode);
      });
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
