function buildCanonicalUrl(type, id) {
  if (!type || !id) {
    return '';
  }
  return `https://music.163.com/#/${type}?id=${id}`;
}

function resolveNeteaseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return null;
  }

  const shorthandMatch = raw.match(/^(song|playlist)\s*[:#]\s*(\d+)$/i);
  if (shorthandMatch) {
    const type = shorthandMatch[1].toLowerCase();
    const id = shorthandMatch[2];
    return {
      source: raw,
      type,
      id,
      canonicalUrl: buildCanonicalUrl(type, id)
    };
  }

  const directPattern = raw.match(/(?:^|\b)(song|playlist)(?:\?|\/|[^\d])*id=(\d+)/i);
  if (directPattern) {
    const type = directPattern[1].toLowerCase();
    const id = directPattern[2];
    return {
      source: raw,
      type,
      id,
      canonicalUrl: buildCanonicalUrl(type, id)
    };
  }

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!host.includes('163.com')) {
      return null;
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    const pathType = pathParts.find((part) => part === 'song' || part === 'playlist');
    const searchId = url.searchParams.get('id');
    if (pathType && searchId) {
      return {
        source: raw,
        type: pathType,
        id: searchId,
        canonicalUrl: buildCanonicalUrl(pathType, searchId)
      };
    }

    if (url.hash) {
      const hashContent = url.hash.replace(/^#\/?/, '');
      const hashUrl = new URL(`https://music.163.com/${hashContent.startsWith('?') ? '' : hashContent}`);
      const hashParts = hashUrl.pathname.split('/').filter(Boolean);
      const hashType = hashParts.find((part) => part === 'song' || part === 'playlist');
      const hashId = hashUrl.searchParams.get('id');
      if (hashType && hashId) {
        return {
          source: raw,
          type: hashType,
          id: hashId,
          canonicalUrl: buildCanonicalUrl(hashType, hashId)
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

module.exports = {
  resolveNeteaseInput,
  buildCanonicalUrl
};
