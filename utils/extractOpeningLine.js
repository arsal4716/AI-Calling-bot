const fs = require('fs');
function extractOpeningLine(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/openingLine:\s*\{([\s\S]*?)\}/m);
  if (!match) return '';

  let openingLine = match[1].trim();
  openingLine = openingLine
    .split('\n')
    .map(line => line.trim().replace(/^"|"$/g, ''))
    .filter(line => line.length > 0)
    .join('\n');

  return openingLine;
}

module.exports = extractOpeningLine;
