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
              matches.push({ index, length: word.length, data, word });
              index = text.indexOf(word, index + 1);
            }
          }

          if (matches.length === 0) continue;

          // Sort by position (longest first at same position)
          matches.sort((a, b) => {
            if (a.index !== b.index) return a.index - b.index;
            return b.length - a.length;
          });

          // Group overlapping matches and keep longest for display
          const finalMatches: Array<{ index: number; length: number; data: WordData; word: string; overlapping: typeof matches }> = [];
          for (const match of matches) {
            const existingGroup = finalMatches.find(
              (existing) =>
                (match.index >= existing.index && match.index < existing.index + existing.length) ||
                (match.index + match.length > existing.index && match.index < existing.index)
            );

            if (existingGroup) {
              // Add to overlapping group
              existingGroup.overlapping.push(match);
            } else {
              // Create new group
              finalMatches.push({ ...match, overlapping: [match] });
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
            span.style.setProperty('position', 'relative', 'important');
            span.style.setProperty('display', 'inline', 'important');
            span.style.setProperty('cursor', 'pointer', 'important');
            span.style.setProperty('transition', 'background-color 0.2s', 'important');
            span.style.setProperty('margin', '0', 'important');
            span.style.setProperty('padding', '0', 'important');
            span.style.setProperty('margin-right', '1px', 'important'); // Small gap between adjacent highlights
            // Prevent font size inheritance issues
            span.style.setProperty('font-size', 'inherit', 'important');
            span.style.setProperty('font-family', 'inherit', 'important');
            span.style.setProperty('font-weight', 'inherit', 'important');
            span.style.setProperty('line-height', 'inherit', 'important');

            // Use the primary match color for background
            const primaryColor = getDifficultyColor(match.overlapping[0].data.difficultyLevel);
            span.style.setProperty('background-color', `${primaryColor}33`, 'important');

            // Add text content
            span.textContent = match.word;

            // Assign vertical levels to overlapping matches
            // Non-overlapping matches should get the same level
            const levels: number[] = [];
            match.overlapping.forEach((m, idx) => {
              let level = 0;
              // Find the lowest level where this match doesn't overlap with any existing match at that level
              while (true) {
                let hasOverlap = false;
                for (let i = 0; i < idx; i++) {
                  if (levels[i] === level) {
                    const other = match.overlapping[i];
                    // Check if they overlap
                    const mEnd = m.index + m.word.length;
                    const otherEnd = other.index + other.word.length;
                    if (!(mEnd <= other.index || m.index >= otherEnd)) {
                      hasOverlap = true;
                      break;
                    }
                  }
                }
                if (!hasOverlap) {
                  levels[idx] = level;
                  break;
                }
                level++;
              }
            });

            // Create stacked underlines as child elements, each matching their word's length
            match.overlapping.forEach((m, idx) => {
              const color = getDifficultyColor(m.data.difficultyLevel);
              const level = levels[idx];
              const offset = 0.1 + (level * 0.15); // Stack underlines in em units based on level

              // Calculate position and width based on where this match starts within the main match
              const relativeStart = m.index - match.index;
              const matchLength = m.word.length;
              const totalLength = match.word.length;

              // Calculate percentage positions with a small gap
              const leftPercent = (relativeStart / totalLength) * 100;
              const widthPercent = (matchLength / totalLength) * 100;

              // Add small gap (2% of total width) between adjacent underlines
              const gapPercent = 2;

              const underline = document.createElement('span');
              underline.style.setProperty('display', 'block', 'important');
              underline.style.setProperty('position', 'absolute', 'important');
              underline.style.setProperty('left', `${leftPercent}%`, 'important');
              underline.style.setProperty('width', `calc(${widthPercent}% - ${gapPercent}%)`, 'important');
              underline.style.setProperty('bottom', `-${offset}em`, 'important');
              underline.style.setProperty('height', '1.5px', 'important');
              underline.style.setProperty('background-color', color, 'important');
              underline.style.setProperty('pointer-events', 'none', 'important');
              underline.style.setProperty('margin', '0', 'important');
              underline.style.setProperty('padding', '0', 'important');

              span.appendChild(underline);
            });

            // Build tooltip with all overlapping matches
            if (match.overlapping.length > 1) {
              const tooltipLines = match.overlapping.map((m) =>
                `${m.word} (${Math.round(m.data.difficultyLevel)}%)`
              ).join('\n');
              span.title = `Multiple matches:\n${tooltipLines}`;
            } else {
              span.title = `${match.word} (${Math.round(match.data.difficultyLevel)}%)`;
            }

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
