/** 将 .gitignore 规则编译一次，避免扫描每个文件时重复解析。无第三方依赖。 */

/** 转换单条通配路径：普通星号不跨目录，双星号可跨任意层级。 */
function compilePattern(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      source += escapeRegex(pattern[++index]);
    } else if (character === '*') {
      const start = index;
      while (pattern[index + 1] === '*') index += 1;
      const doubleStar = index > start && (start === 0 || pattern[start - 1] === '/')
        && (index + 1 === pattern.length || pattern[index + 1] === '/');
      if (doubleStar && pattern[index + 1] === '/') {
        source += '(?:[^/]+/)*';
        index += 1;
      } else {
        source += doubleStar ? '.*' : '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end > index + 1) {
        let contents = pattern.slice(index + 1, end);
        if (contents.startsWith('!')) contents = `^${contents.slice(1)}`;
        source += `(?!/)[${contents.replace(/\\/g, '\\\\')}]`;
        index = end;
      } else source += '\\[';
    } else source += escapeRegex(character);
  }
  return source;
}

function escapeRegex(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text 当前目录 .gitignore 正文。
 * @param {string} basePath 配置所在目录相对于扫描根目录的路径。
 * @returns {object[]} 按原始顺序排列的规则；后面的匹配覆盖前面的结果。
 */
export function parseIgnoreRules(text, basePath) {
  const rules = [];
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    // 未转义的行尾空格不属于模式；反斜杠转义的空格需要保留。
    while (line.endsWith(' ')) {
      const preceding = line.slice(0, -1).match(/\\+$/)?.[0].length || 0;
      if (preceding % 2 === 1) break;
      line = line.slice(0, -1);
    }
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    if (!line) continue;
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    try {
      rules.push({ basePath, negated, directoryOnly, expression: new RegExp(`^${anchored ? '' : '(?:[^/]+/)*'}${compilePattern(line)}$`) });
    } catch {
      // 无效字符范围不应中断整个目录扫描，也不应意外忽略文件。
    }
  }
  return rules;
}

/** 父目录被忽略后不会进入，因此其中的反向规则不能重新包含子文件。 */
export function isIgnored(relativePath, isDirectory, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const prefix = rule.basePath ? `${rule.basePath}/` : '';
    if (!relativePath.startsWith(prefix)) continue;
    if (rule.expression.test(relativePath.slice(prefix.length))) ignored = !rule.negated;
  }
  return ignored;
}
