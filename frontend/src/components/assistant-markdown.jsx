import { createElement, Fragment, useMemo } from 'react';
import { Lexer } from 'marked';
import { decodeHTMLStrict } from 'entities/decode';

// Model output is untrusted. Only consume lexer tokens, never generated HTML.
// Links/images are deliberately inert: only server-issued citations can navigate.
function renderMarkdown(text) {
  try {
    // Match the server response ceiling; retain oversized/deep content as text.
    if (text.length > 65536) {
      throw Error('Markdown size limit');
    }

    let count = 0;
    function render(tokens, depth = 0) {
      if (depth > 32) {
        throw Error('Markdown nesting limit');
      }

      return tokens.map((token, key) => {
        if (++count > 10000) {
          throw Error('Markdown token limit');
        }

        const children = () => render(token.tokens || [], depth + 1);
        switch (token.type) {
          case 'space':
          case 'def':
          case 'html':
            return null;
          case 'text':
            return token.tokens ? <Fragment key={key}>{children()}</Fragment> : decodeHTMLStrict(token.text);
          case 'escape':
            return token.text;
          case 'paragraph':
            return <p key={key}>{children()}</p>;
          case 'heading':
            return createElement(`h${Math.min(6, Math.max(3, token.depth + 2))}`, { key }, children());
          case 'strong':
          case 'em':
          case 'del':
          case 'blockquote':
            return createElement(token.type, { key }, children());
          case 'br':
          case 'hr':
            return createElement(token.type, { key });
          case 'codespan':
            return <code key={key}>{token.text}</code>;
          case 'code':
            return (
              <pre key={key} tabIndex={0} role="region" aria-label="Code block">
                <code>{token.text}</code>
              </pre>
            );
          case 'link':
          case 'image':
            return <Fragment key={key}>{children()}</Fragment>;
          case 'list':
            return createElement(
              token.ordered ? 'ol' : 'ul',
              { key, start: token.ordered && Number.isSafeInteger(token.start) ? token.start : undefined },
              render(token.items, depth + 1)
            );
          case 'list_item':
            return <li key={key}>{children()}</li>;
          case 'checkbox':
            return <span key={key}>{token.checked ? '[Done] ' : '[To do] '}</span>;
          case 'table':
            return (
              <div key={key} className="assistant-table" tabIndex={0} role="region" aria-label="Response table">
                <table>
                  <thead>
                    <tr>
                      {token.header.map((cell, index) => (
                        <th key={index} scope="col">
                          {render(cell.tokens, depth + 1)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {token.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((cell, column) => (
                          <td key={column}>{render(cell.tokens, depth + 1)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return token.raw || '';
        }
      });
    }

    return render(Lexer.lex(text, { gfm: true }));
  } catch {
    return <p className="assistant-markdown-plain">{text}</p>;
  }
}

export function AssistantMarkdown({ text }) {
  const content = useMemo(() => renderMarkdown(text), [text]);
  return <div className="assistant-markdown">{content}</div>;
}
