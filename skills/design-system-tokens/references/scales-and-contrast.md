# Scales and contrast

Type scale, spacing grid and contrast arithmetic. Adapted from alirezarezvani/claude-skills ui-design-system (references/token-generation.md); the generator script and its colour algorithm are not included.

## Typography Scale System

### Modular Scale (Major Third)

A **1.25x ratio** (major third) creates harmonious font sizes.

```
Base: 16px

Scale calculation:
  Smaller sizes: 16px ÷ 1.25^n
  Larger sizes: 16px × 1.25^n

Result:
  xs:   10px (16 ÷ 1.25²)
  sm:   13px (16 ÷ 1.25¹)
  base: 16px
  lg:   20px (16 × 1.25¹)
  xl:   25px (16 × 1.25²)
  2xl:  31px (16 × 1.25³)
  3xl:  39px (16 × 1.25⁴)
  4xl:  49px (16 × 1.25⁵)
  5xl:  61px (16 × 1.25⁶)
```

Round to whole pixels (or to rem with two or three decimals). For UI text, avoid going below 12px for anything people need to read; on a 1.25 scale that means `xs` is for incidental text only, or is replaced by a fixed 12px step.

### Type Scale Ratios

| Ratio | Name | Multiplier | Character |
|-------|------|------------|-----------|
| 1.067 | Minor Second | Tight | Compact UIs |
| 1.125 | Major Second | Subtle | App interfaces |
| 1.200 | Minor Third | Moderate | General use |
| **1.250** | **Major Third** | **Balanced** | **Default** |
| 1.333 | Perfect Fourth | Pronounced | Marketing |
| 1.414 | Augmented Fourth | Bold | Editorial |
| 1.618 | Golden Ratio | Dramatic | Headlines |

### Pre-composed Text Styles

| Style | Size | Weight | Line Height | Letter Spacing |
|-------|------|--------|-------------|----------------|
| h1 | 48px | 700 | 1.2 | -0.02em |
| h2 | 36px | 700 | 1.3 | -0.01em |
| h3 | 28px | 600 | 1.4 | 0 |
| h4 | 24px | 600 | 1.4 | 0 |
| h5 | 20px | 600 | 1.5 | 0 |
| h6 | 16px | 600 | 1.5 | 0.01em |
| body | 16px | 400 | 1.5 | 0 |
| small | 14px | 400 | 1.5 | 0 |
| caption | 12px | 400 | 1.5 | 0.01em |

---

## Spacing Grid System

### 8pt Grid Foundation

All spacing values are multiples of 8px (with 4px half-steps) for visual consistency.

```
Base Unit: 8px

Multipliers: 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8...

Results:
  0:  0px
  1:  4px  (0.5 × 8)
  2:  8px  (1 × 8)
  3:  12px (1.5 × 8)
  4:  16px (2 × 8)
  5:  20px (2.5 × 8)
  6:  24px (3 × 8)
  ...
```

### Semantic Spacing Mapping

| Token | Numeric | Value | Use Case |
|-------|---------|-------|----------|
| xs | 1 | 4px | Inline icon margins |
| sm | 2 | 8px | Button padding |
| md | 4 | 16px | Card padding |
| lg | 6 | 24px | Section spacing |
| xl | 8 | 32px | Component gaps |
| 2xl | 12 | 48px | Section margins |
| 3xl | 16 | 64px | Page sections |

### Why 8pt Grid?

1. **Divisibility**: 8 divides evenly into common screen widths
2. **Consistency**: Creates predictable vertical rhythm
3. **Accessibility**: Touch targets naturally align to 48px (8 × 6)

---

## Accessibility Contrast

### WCAG Contrast Requirements

| Level | Normal Text | Large Text | Definition |
|-------|-------------|------------|------------|
| AA | 4.5:1 | 3:1 | Minimum requirement |
| AAA | 7:1 | 4.5:1 | Enhanced accessibility |

**Large text**: ≥18pt regular or ≥14pt bold (about 24px and 18.7px in CSS pixels).

Non-text contrast (WCAG 2.2 AA): visual boundaries of controls (input outlines, toggles), focus indicators and meaningful icons need at least 3:1 against adjacent colours.

### Contrast Ratio Formula

```
Contrast Ratio = (L1 + 0.05) / (L2 + 0.05)

Where:
  L1 = Relative luminance of lighter color
  L2 = Relative luminance of darker color

Relative Luminance:
  L = 0.2126 × R + 0.7152 × G + 0.0722 × B
  (Values linearized from sRGB)
```

Linearizing each sRGB channel: take the 0–255 value and divide by 255 to get `c`; if `c ≤ 0.03928` the linear value is `c / 12.92`, otherwise it is `((c + 0.055) / 1.055) ^ 2.4`. Apply this to R, G and B before the weighted sum.

Worked anchors (computed with the formula above), useful as sanity checks:

| Foreground | Background | Ratio |
|---|---|---|
| #3b82f6 (a mid blue) | #ffffff | 3.68:1, fails AA for body text |
| #2563eb (one step darker) | #ffffff | 5.17:1, passes |
| #737373 (mid grey) | #ffffff | 4.74:1, passes |
| #737373 | #0a0a0a | 4.18:1, fails for body text |
| #a3a3a3 (light grey) | #ffffff | 2.52:1, fails even for large text |

Lesson: the "500" step of a ramp is often fine as a fill but too light for text on white, and the same grey that passes on white can fail on near-black. Check each mode separately.
