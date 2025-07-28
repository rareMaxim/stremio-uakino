const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const UAKINO_BASE_URL = 'https://uakino.best';
const CACHE_FILE_PATH = './genre_cache.json';
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 днів

async function parseGenres(url) {
    try {
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
        const $ = cheerio.load(response.data);
        const genres = {};
        $('select[name="o.cat"] option').each((index, element) => {
            const name = $(element).text().trim();
            const value = $(element).attr('value');
            if (value && name && name.toLowerCase() !== 'всі жанри') {
                genres[name] = value;
            }
        });
        return genres;
    } catch (error) {
        console.error(`[Парсер] Помилка парсингу жанрів з ${url}: ${error.message}`);
        return {};
    }
}

async function loadGenresWithCache() {
    if (fs.existsSync(CACHE_FILE_PATH)) {
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE_PATH, 'utf-8'));
        if (Date.now() - cache.timestamp < CACHE_DURATION_MS) {
            console.log('[Кеш] Використовую кешовані жанри.');
            return { movieGenres: cache.movieGenres, seriesGenres: cache.seriesGenres };
        }
    }
    console.log('[Кеш] Парсимо нові жанри...');
    const movieGenres = await parseGenres(`${UAKINO_BASE_URL}/filmy/`);
    const seriesGenres = await parseGenres(`${UAKINO_BASE_URL}/seriesss/`);
    const cacheData = { timestamp: Date.now(), movieGenres, seriesGenres };
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2));
    console.log('[Кеш] Нові жанри збережено.');
    return { movieGenres, seriesGenres };
}

async function startAddon() {
    const { movieGenres, seriesGenres } = await loadGenresWithCache();

    const manifest = {
        id: 'org.uakino.best.final.ui.fix',
        version: '5.5.0',
        name: 'uakino.best',
        description: 'Повнофункціональний додаток для uakino.best з вибором якості відео.',
        logo: `${UAKINO_BASE_URL}/templates/uakino/images/logo.svg`,
        types: ['movie', 'series'],
        catalogs: [
            { id: 'uakino-premieres', type: 'movie', name: 'Новинки прокату (uakino)' },
            { id: 'uakino-movies', type: 'movie', name: 'Фільми (uakino)', extra: [{ name: 'genre', options: Object.keys(movieGenres), isRequired: false }] },
            { id: 'uakino-series', type: 'series', name: 'Серіали (uakino)', extra: [{ name: 'genre', options: Object.keys(seriesGenres), isRequired: false }] }
        ],
        resources: ['catalog', 'meta', 'stream']
    };

    const builder = new addonBuilder(manifest);

    const buildCorrectUrl = (argsId) => {
        const parts = argsId.split(':');
        const type = parts[1];
        const encodedPath = parts[2];
        if (!encodedPath) return { type: null, pageUrl: null };
        let fullPath = decodeURIComponent(encodedPath);
        fullPath = fullPath.replace(/_/g, '-');
        const pageUrl = `${UAKINO_BASE_URL}/${fullPath}`;
        return { type, pageUrl };
    };

    builder.defineCatalogHandler(async (args) => {
        const { type, id, extra } = args;
        const selectedGenre = extra ? extra.genre : null;
        let targetUrl;
        let selector;
        if (id === 'uakino-premieres') {
            targetUrl = UAKINO_BASE_URL;
            selector = '.top-header .swiper-slide.movie-item';
        } else if (selectedGenre) {
            const genreId = (type === 'movie' ? movieGenres : seriesGenres)[selectedGenre];
            targetUrl = `${UAKINO_BASE_URL}/f/o.cat=${genreId}/`;
            selector = 'div.movie-item';
        } else {
            targetUrl = type === 'movie' ? `${UAKINO_BASE_URL}/filmy/` : `${UAKINO_BASE_URL}/seriesss/`;
            selector = 'div.movie-item';
        }
        const metas = [];
        try {
            const response = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
            const $ = cheerio.load(response.data);
            $(selector).each((index, element) => {
                const titleElement = $(element).find('a.movie-title');
                const title = titleElement.text().trim();
                if (title) {
                    const pageUrl = titleElement.attr('href');
                    let posterUrl = $(element).find('img').attr('src');
                    const description = $(element).find('.movie-text .desc-about-text, .movie-desc').text().trim();
                    const year = $(element).find('.movie-desk-item:contains("Рік виходу:"), .fi-label:contains("Рік виходу:")').next().text().trim();
                    const imdbRating = $(element).find('.movie-desk-item:contains("IMDB:"), .fi-label:contains("IMDB:")').next().text().trim() || null;
                    const seasonInfo = $(element).find('.full-season').text().trim();
                    const finalName = seasonInfo ? `${title} (${seasonInfo})` : title;
                    if (posterUrl && posterUrl.startsWith('/')) { posterUrl = UAKINO_BASE_URL + posterUrl; }
                    const isSeries = /сезон/i.test(title) || (pageUrl && (pageUrl.includes('/series/') || pageUrl.includes('/cartoon/cartoonseries/') || pageUrl.includes('/animeukr/')));
                    const itemType = isSeries ? 'series' : 'movie';
                    const fullPath = new URL(pageUrl, UAKINO_BASE_URL).pathname.substring(1);
                    const itemId = `uakino:${itemType}:${encodeURIComponent(fullPath)}`;
                    metas.push({ id: itemId, type: itemType, name: finalName, poster: posterUrl, description, releaseInfo: year, imdbRating });
                }
            });
        } catch (error) { console.error(`[CATALOG] Помилка: ${error.message}`); }
        return Promise.resolve({ metas });
    });

    builder.defineMetaHandler(async (args) => {
        const { type, pageUrl } = buildCorrectUrl(args.id);
        if (!pageUrl) return Promise.resolve({ meta: {} });
        try {
            const response = await axios.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
            const $ = cheerio.load(response.data);
            const getTextFromLinks = (selector) => $(selector).map((i, el) => $(el).text().trim()).get();
            const name = $('h1[itemprop="name"]').text().trim();
            const posterSrc = $('div.film-poster img').attr('src');
            const poster = posterSrc ? UAKINO_BASE_URL + posterSrc : '';
            const description = $('.full-text.clearfix[itemprop="description"]').text().trim();
            const backgroundSrc = $('meta[property="og:image"]').attr('content');
            const background = backgroundSrc ? (backgroundSrc.startsWith('http') ? backgroundSrc : UAKINO_BASE_URL + backgroundSrc) : null;
            const genres = getTextFromLinks('.fi-item:contains("Жанр:") a');
            const director = getTextFromLinks('.fi-item:contains("Режисер:") a');
            const cast = getTextFromLinks('.fi-item:contains("Актори:") a');
            const country = getTextFromLinks('.fi-item:contains("Країна:") a').join(', ');
            const runtime = $('.fi-item:contains("Тривалість:") .fi-desc').text().trim();
            const imdbRating = $('.fi-item:contains("IMDB:") .fi-desc').text().trim().split('/')[0];
            const trailerDataSrc = $(`li:contains("Трейлер")`).parent().next('.box').find('iframe').attr('data-src');

            const meta = { id: args.id, type, name, poster, description, background, genres, director, cast, country, runtime, imdbRating, videos: [] };

            if (trailerDataSrc && trailerDataSrc.includes('youtube.com')) {
                try {
                    // Extract YouTube video ID for the trailer
                    const trailerUrl = new URL(trailerDataSrc);
                    const videoId = trailerUrl.searchParams.get('v') || trailerUrl.pathname.split('/').pop();
                    if (videoId) meta.trailer = `yt_id:${videoId}`;
                } catch (e) { console.error("Could not parse trailer URL"); }
            }

            if (type === 'series') {
                let currentSeason = 0;
                $('#episodes-list > .playlists-items > ul > li').each((index, element) => {
                    if ($(element).hasClass('playlists-season')) {
                        const seasonText = $(element).text().trim();
                        const seasonMatch = seasonText.match(/(\d+)\s*Сезон/i);
                        if (seasonMatch) { currentSeason = parseInt(seasonMatch[1], 10); }
                    }
                    else if ($(element).attr('data-file')) {
                        const episodeTitle = $(element).text().trim();
                        const episodeMatch = episodeTitle.match(/(\d+)\s*серія/i);
                        const episodeNum = episodeMatch ? parseInt(episodeMatch[1], 10) : (index + 1);
                        if (currentSeason > 0) {
                            const episodeId = `${args.id}:${currentSeason}:${episodeNum}`;
                            meta.videos.push({ id: episodeId, title: episodeTitle, season: currentSeason, episode: episodeNum, released: new Date() });
                        }
                    }
                });
            }
            // --- ВИДАЛЕНО ЗАЙВИЙ КРОК ДЛЯ ФІЛЬМІВ ---
            // Stremio сам зрозуміє, що для фільму треба шукати стріми, 
            // якщо масив videos залишиться порожнім. Це прибере проміжний крок.

            return Promise.resolve({ meta });
        } catch (error) {
            console.error(`[META] Помилка для ${pageUrl}: ${error.message}`);
            return Promise.resolve({ meta: {} });
        }
    });

    builder.defineStreamHandler(async (args) => {
        try {
            const { pageUrl } = buildCorrectUrl(args.id);
            const newsIdMatch = pageUrl.match(/(\d+)-/);
            if (!newsIdMatch) throw new Error(`Не вдалося знайти ID новини в: ${pageUrl}`);
            const newsId = newsIdMatch[1];

            const pageResponse = await axios.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
            const $page = cheerio.load(pageResponse.data);
            let dleEditTime = null;
            $page('script').each((i, el) => {
                const scriptContent = $page(el).html();
                const match = scriptContent.match(/var dle_edittime\s*=\s*'(\d+)'/);
                if (match && match[1]) { dleEditTime = match[1]; return false; }
            });
            if (!dleEditTime) throw new Error('Не вдалося знайти dle_edittime на сторінці');

            const playlistUrl = `${UAKINO_BASE_URL}/engine/ajax/playlists.php?news_id=${newsId}&xfield=playlist&time=${dleEditTime}`;
            const response = await axios.get(playlistUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36', 'Referer': pageUrl, 'X-Requested-With': 'XMLHttpRequest' } });

            const playlistHtml = response.data.response;
            if (playlistHtml && typeof playlistHtml === 'string') {
                const $ = cheerio.load(playlistHtml);
                const streams = [];
                const playerSources = [];

                $('li[data-file]').each((index, element) => {
                    let playerPageUrl = $(element).attr('data-file');
                    if (playerPageUrl.startsWith('//')) { playerPageUrl = 'https:' + playerPageUrl; }
                    const streamTitle = $(element).text().trim() || 'Дивитись';
                    playerSources.push({ url: playerPageUrl, title: streamTitle });
                });

                for (const player of playerSources) {
                    try {
                        const playerPageResponse = await axios.get(player.url, { headers: { 'Referer': UAKINO_BASE_URL } });
                        const masterM3u8Match = playerPageResponse.data.match(/(https?:\/\/[^\s"']+\.m3u8)/);
                        if (masterM3u8Match && masterM3u8Match[1]) {
                            const masterM3u8Url = masterM3u8Match[1];
                            const masterPlaylistResponse = await axios.get(masterM3u8Url, { headers: { 'Referer': player.url } });
                            const lines = masterPlaylistResponse.data.trim().split('\n');

                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                    const resolutionMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
                                    const qualityUrl = lines[i + 1];
                                    if (qualityUrl) {
                                        let qualityLabel = 'SD';
                                        if (resolutionMatch && resolutionMatch[2]) {
                                            const height = parseInt(resolutionMatch[2], 10);
                                            if (!isNaN(height)) {
                                                if (height >= 2160) qualityLabel = '4K';
                                                else if (height >= 1080) qualityLabel = '1080p';
                                                else if (height >= 720) qualityLabel = '720p';
                                                else if (height >= 480) qualityLabel = '480p';
                                                else qualityLabel = `${height}p`;
                                            }
                                        } else {
                                            if (qualityUrl.includes('/2160/')) qualityLabel = '4K';
                                            else if (qualityUrl.includes('/1080/')) qualityLabel = '1080p';
                                            else if (qualityUrl.includes('/720/')) qualityLabel = '720p';
                                            else if (qualityUrl.includes('/480/')) qualityLabel = '480p';
                                        }

                                        streams.push({
                                            name: `UAKINO - ${player.title}`,
                                            title: `▶️ ${qualityLabel}`,
                                            url: qualityUrl.startsWith('http') ? qualityUrl : new URL(qualityUrl, masterM3u8Url).href,
                                            behaviorHints: { headers: { 'Referer': UAKINO_BASE_URL, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } }
                                        });
                                    }
                                }
                            }
                        }
                    } catch (e) { /* Ігноруємо помилки для окремих плеєрів */ }
                }

                if (streams.length > 0) {
                    return Promise.resolve({ streams });
                }
            }

            return Promise.resolve({ streams: [] });
        } catch (error) {
            console.error(`[STREAM] Помилка: ${error.message}`);
            return Promise.resolve({ streams: [] });
        }
    });

    const PORT = 3000;

    serveHTTP(builder.getInterface(), {
        port: PORT,
        static: '/public',
        cors: {
            origin: '*'
        }
    });
    console.log(`\n✅ Додаток запущено! Встановіть його у Stremio за цим посиланням:\nhttp://127.0.0.1:${PORT}/manifest.json`);
}

startAddon();