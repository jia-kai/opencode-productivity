# OpenCode Markdown and LaTeX Preview

This document exercises the standalone preview viewer. Inline mathematics such as
$e^{i\pi} + 1 = 0$ should align naturally with the surrounding text.

## Display equations

The quadratic formula:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

A multiline aligned derivation:

$$
\begin{aligned}
(a+b)^2
  &= (a+b)(a+b) \\
  &= a^2 + ab + ba + b^2 \\
  &= a^2 + 2ab + b^2
\end{aligned}
$$

And a matrix:

$$
A =
\begin{pmatrix}
1 & 2 & 3 \\
4 & 5 & 6 \\
7 & 8 & 9
\end{pmatrix}
$$

## Markdown

> A blockquote can contain **strong text**, *emphasis*, and inline math
> $\sum_{k=1}^{n} k = n(n+1)/2$.

- A normal list item
- A nested list
  - First nested item
  - Second nested item containing `inline_code()`
- A final item with a [link](https://opencode.ai/)

| Feature | Expected result |
| --- | --- |
| Headings | OpenCode theme heading color |
| Code | Monospace with syntax highlighting |
| Mathematics | Browser-rendered MathML |
| Long content | Split across navigable pages |

```typescript
export function fibonacci(n: number): number {
  if (n < 2) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}
```

## Additional content for paging

The viewer rasterizes long output into pages. Use `j`/`k` or the arrow keys to move
between pages, `r` to redraw after a terminal change, and `q` or Escape to close.

For a Gaussian integral:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

The following paragraphs provide enough vertical content to exercise layout,
wrapping, and page boundaries.

1. Markdown is converted to HTML by Pandoc.
2. LaTeX is emitted as MathML.
3. Chromium lays out the themed document.
4. The viewer captures PNG pages.
5. Kitty displays the selected page through tmux passthrough.

---

End of sample.
