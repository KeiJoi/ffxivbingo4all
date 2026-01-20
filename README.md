#### FFXIV BINGO 4 ALL ####

## Web Client Custom Images

All image overrides are done with CSS in `backend/public/styles.css`. Put image
files under `backend/public/images` (or any path under `backend/public`) and
reference them with `url("images/your-file.png")`.

Use `color: transparent` and `background-size: contain` so the text is hidden
and the image scales nicely.

### Replace a header letter with an image
Targets the header position (1-5).

```css
.card-header .header-cell:nth-child(3) {
  color: transparent;
  background-image: url("images/paw.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
```

### Replace a specific card number with an image
Applies to the grid numbers on the card.

```css
.bingo-cell[data-number="42"] {
  color: transparent;
  background-image: url("images/number-42.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
```

If you only want the image after it is called or daubed:

```css
.bingo-cell.called[data-number="42"] { /* only when called */
  color: transparent;
  background-image: url("images/number-42.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}

.bingo-cell.daubed[data-number="42"] { /* only when daubed */
  color: transparent;
  background-image: url("images/number-42.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
```

### Replace the free spot

```css
.bingo-cell[data-number="free"] {
  color: transparent;
  background-image: url("images/free-logo.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
```

### Replace called-number panel entries
These are the balls in the called list on the left.

```css
.called-number[data-number="42"] {
  color: transparent;
  background-image: url("images/number-42.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}

.called-number.called[data-number="42"] { /* only when called */
  color: transparent;
  background-image: url("images/number-42.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
```

### Image sizing tips
- The card balls are sized by `--card-ball-size` in `backend/public/styles.css`.
- The called list balls are sized by `--called-ball-size`.
- For crisp results, use images at 2x the displayed size (PNG or SVG).
