# Icon Required for Marketplace Publishing

## Requirements

The VS Code Marketplace requires a **128x128 PNG icon** for the extension.

## Current Status

- ✅ SVG icon exists: `resources/icon.svg`
- ❌ PNG icon needed: `resources/icon.png`

## Action Needed

Convert the SVG icon to a 128x128 PNG:

```bash
# Using ImageMagick (if available):
convert -background none -resize 128x128 resources/icon.svg resources/icon.png

# Or using online converters:
# - https://cloudconvert.com/svg-to-png
# - https://www.aconvert.com/image/svg-to-png/
```

## Marketplace Guidelines

- **Size**: 128x128 pixels
- **Format**: PNG
- **Background**: Transparent recommended
- **Content**: Simple, recognizable design that works at small sizes

## References

- [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
