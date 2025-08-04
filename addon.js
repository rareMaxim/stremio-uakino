const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const UAKINO_BASE_URL = 'https://uakino.best';
const CACHE_FILE_PATH = './genre_cache.json';
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Створюємо об'єкт Map для кешування пошукових результатів
const searchCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // Час життя кешу - 1 година

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
    } catch (error) { console.error(`[Парсер] Помилка: ${error.message}`); return {}; }
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
        id: 'org.uakino.best.final.all.features.v3',
        version: '6.2.0',
        name: 'uakino.best',
        description: 'Повнофункціональний додаток для uakino.best.',
        logo: `${UAKINO_BASE_URL}/templates/uakino/images/logo.svg`,
        types: ['movie', 'series'],
        catalogs: [
            {
                id: 'uakino-premieres',
                type: 'movie',
                name: 'Новинки прокату (uakino)'
            },
            {
                id: 'uakino-movies',
                type: 'movie',
                name: 'Фільми (uakino)',
                extra: [
                    {
                        name: 'genre',
                        options: Object.keys(movieGenres)
                    },
                    {
                        name: 'search',
                        isRequired: false
                    }
                ]
            },
            {
                id: 'uakino-series',
                type: 'series',
                name: 'Серіали (uakino)',
                extra: [
                    {
                        name: 'genre',
                        options: Object.keys(seriesGenres)
                    },
                    {
                        name: 'search',
                        isRequired: false
                    }
                ]
            }
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

    function parseAndCategorizeItems($, selector) {
        console.log(`[Парсер] Розпочато парсинг та категоризацію елементів за селектором: "${selector}"`);
        const results = {
            movies: [],
            series: []
        };

        // Використовуємо переданий селектор тут
        $(selector).each((index, element) => {
            const titleElement = $(element).find('a.movie-title');
            const title = titleElement.text().trim();

            if (title) {
                // ... вся інша логіка парсингу залишається абсолютно такою ж
                const pageUrl = titleElement.attr('href');
                let posterUrl = $(element).find('img').attr('src');

                const isSeries = /сезон/i.test(title) || (pageUrl && (pageUrl.includes('/seriesss/') || pageUrl.includes('/cartoon/cartoonseries/') || pageUrl.includes('/animeukr/')));
                const itemType = isSeries ? 'series' : 'movie';

                const description = $(element).find('.movie-text .desc-about-text, .movie-desc').text().trim();
                const year = $(element).find('.movie-desk-item:contains("Рік виходу:"), .fi-label:contains("Рік виходу:")').next().text().trim();
                const imdbRating = $(element).find('.movie-desk-item:contains("IMDB:"), .fi-label:contains("IMDB:")').next().text().trim() || null;
                const seasonInfo = $(element).find('.full-season').text().trim();
                const finalName = seasonInfo ? `${title} (${seasonInfo})` : title;

                if (posterUrl && posterUrl.startsWith('/')) { posterUrl = UAKINO_BASE_URL + posterUrl; }

                const fullPath = new URL(pageUrl, UAKINO_BASE_URL).pathname.substring(1);
                const itemId = `uakino:${itemType}:${encodeURIComponent(fullPath)}`;

                const meta = {
                    id: itemId, type: itemType, name: finalName, poster: posterUrl,
                    description, releaseInfo: year, imdbRating
                };

                if (itemType === 'movie') {
                    results.movies.push(meta);
                } else {
                    results.series.push(meta);
                }
            }
        });

        console.log(`[Парсер] Завершено. Фільмів: ${results.movies.length}, Серіалів: ${results.series.length}`);
        return results;
    }

    builder.defineCatalogHandler(async (args) => {
        const { type, id, extra } = args;
        const searchQuery = extra ? extra.search : null;
        const selectedGenre = extra ? extra.genre : null;
        let metas = [];

        try {
            if (searchQuery) {
                const cacheKey = searchQuery.toLowerCase();
                let categorizedResults = null;

                if (searchCache.has(cacheKey)) {
                    const cachedData = searchCache.get(cacheKey);
                    if (Date.now() - cachedData.timestamp < CACHE_TTL_MS) {
                        console.log(`[CACHE HIT] Знайдено валідний кеш для запиту: "${cacheKey}"`);
                        categorizedResults = cachedData;
                    }
                }

                if (!categorizedResults) {
                    console.log(`[CACHE MISS] Виконуємо мережевий запит для: "${cacheKey}"`);
                    const searchUrl = `${UAKINO_BASE_URL}/index.php?do=search`;
                    const params = new URLSearchParams({ 'do': 'search', 'subaction': 'search', 'story': searchQuery });
                    const response = await axios.post(searchUrl, params, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
                    const $ = cheerio.load(response.data);

                    // На сторінці пошуку селектор завжди однаковий
                    const parsedData = parseAndCategorizeItems($, 'div.movie-item');

                    categorizedResults = { ...parsedData, timestamp: Date.now() };
                    searchCache.set(cacheKey, categorizedResults);
                    console.log(`[CACHED] Збережено результати для "${cacheKey}"`);
                }

                if (type === 'movie') {
                    metas = categorizedResults.movies;
                } else if (type === 'series') {
                    metas = categorizedResults.series;
                }
                console.log(metas);
            } else {
                // --- ТУТ ЗМІННА selector ТЕПЕР ВИКОРИСТОВУЄТЬСЯ ---
                let targetUrl, selector;
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

                console.log(`[CATALOG] Запит на каталог: '${id}', Цільовий URL: ${targetUrl}`);
                const response = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
                const $ = cheerio.load(response.data);

                // Тепер ми передаємо динамічний селектор в парсер
                const categorizedItems = parseAndCategorizeItems($, selector);

                if (type === 'movie') {
                    metas = categorizedItems.movies;
                } else if (type === 'series') {
                    metas = categorizedItems.series;
                }
            }
        } catch (error) {
            console.error(`[CATALOG] Помилка: ${error.message}`);
            // reject(new Error('[CATALOG] Помилка: ${error.message}'))
        }

        console.log(`[CATALOG] Для запиту (type: ${type}, id: ${id}) знайдено ${metas.length} елементів.`);
        return Promise.resolve({ metas });
    });

    builder.defineMetaHandler(async (args) => {
        const { type, pageUrl } = buildCorrectUrl(args.id);
        if (!pageUrl) return Promise.resolve({ meta: {} });
        try {
            const response = await axios.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } });
            const $ = cheerio.load(response.data);

            // --- Основна логіка парсингу метаданих (залишається без змін) ---
            const getTextFromLinks = (selector) => $(selector).map((i, el) => $(el).text().trim()).get();
            const nameWithSeason = $('h1[itemprop="name"]').text().trim() || $('h1 span.solototle').text().trim();
            // Прибираємо номер сезону з назви, щоб назва серіалу була однаковою
            const name = nameWithSeason.replace(/\s*\d+\s*сезон/i, '').trim();
            const posterSrc = $('div.film-poster img').attr('src');
            const poster = posterSrc ? UAKINO_BASE_URL + posterSrc : '';
            const description = $('.full-text.clearfix[itemprop="description"]').text().trim();
            const backgroundSrc = $('meta[property="og:image"]').attr('content');
            const background = backgroundSrc ? (backgroundSrc.startsWith('http') ? backgroundSrc : UAKINO_BASE_URL + backgroundSrc) : null;
            const genres = getTextFromLinks('.fi-item:contains("Жанр:") a, .fi-item-s:contains("Жанр:") a');
            const director = getTextFromLinks('.fi-item:contains("Режисер:") a, .fi-item-s:contains("Режисер:") a');
            const cast = getTextFromLinks('.fi-item:contains("Актори:") a, .fi-item-s:contains("Актори:") a');
            const country = getTextFromLinks('.fi-item:contains("Країна:") a, .fi-item-s:contains("Країна:") a').join(', ');
            const runtime = $('.fi-item:contains("Тривалість:") .fi-desc, .fi-item-s:contains("Тривалість:") .fi-desc').text().trim();
            const imdbRating = $('.fi-item:contains("IMDB:") .fi-desc, .fi-item-s:contains("IMDB:") .fi-desc').text().trim().split('/')[0];

            const meta = { id: args.id, type, name, poster, description, background, genres, director, cast, country, runtime, imdbRating, videos: [] };

            // --- ЛОГІКА ДЛЯ ДОДАВАННЯ ІНШИХ СЕЗОНІВ ---
            const otherSeasons = [];
            $('ul.seasons li a').each((index, element) => {
                const seasonUrl = $(element).attr('href');
                const seasonText = $(element).text().trim(); // напр. "4 сезон"

                if (seasonUrl && seasonText) {
                    const seasonPath = new URL(seasonUrl).pathname.substring(1);
                    const seasonId = `uakino:series:${encodeURIComponent(seasonPath)}`;
                    const seasonMatch = seasonText.match(/(\d+)/);
                    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : index + 1;

                    // Створюємо спеціальний об'єкт, який буде виглядати як папка
                    otherSeasons.push({
                        id: seasonId,
                        title: `📁 ${seasonText}`,
                        season: seasonNum,
                        episode: 0, // Використовуємо 0, щоб відрізняти від реальних серій
                        released: new Date(0) // Ставимо дуже стару дату, щоб вони були вгорі списку
                    });
                }
            });

            // --- Логіка парсингу серій для ПОТОЧНОГО сезону ---
            const newsIdMatch = pageUrl.match(/(\d+)-/);
            if (newsIdMatch && newsIdMatch[1]) {
                const newsId = newsIdMatch[1];
                const playlistHtml = await getPlaylistHtml(newsId, pageUrl);
                const $playlist = cheerio.load(playlistHtml);
                let currentSeason = 0;

                // Визначаємо номер поточного сезону з заголовка h1
                const currentSeasonMatch = nameWithSeason.match(/(\d+)\s*сезон/i);
                currentSeason = currentSeasonMatch ? parseInt(currentSeasonMatch[1], 10) : 1;

                $playlist('.playlists-items > ul > li').each((index, element) => {
                    if ($(element).attr('data-file')) {
                        const episodeTitle = $(element).text().trim();
                        const episodeMatch = episodeTitle.match(/(\d+)\s*серія/i);
                        // Якщо номер серії не знайдено, використовуємо індекс як запасний варіант
                        const episodeNum = episodeMatch ? parseInt(episodeMatch[1], 10) : index + 1;

                        if (currentSeason > 0) {
                            meta.videos.push({
                                id: `${args.id}:${currentSeason}:${episodeNum}`,
                                title: episodeTitle,
                                season: currentSeason,
                                episode: episodeNum,
                                released: new Date()
                            });
                        }
                    }
                });
            }

            // Об'єднуємо посилання на інші сезони та серії поточного
            // Розміщуємо інші сезони на початку списку для зручності
            meta.videos = [...otherSeasons, ...meta.videos];

            return Promise.resolve({ meta });
        } catch (error) {
            console.error(`[META] Помилка для ${pageUrl}: ${error.message}`);
            return Promise.resolve({ meta: {} });
        }
    });

    const getPlaylistHtml = async (newsId, pageUrl) => {
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
        return response.data.response;
    };

    builder.defineStreamHandler(async (args) => {
        try {
            const { pageUrl } = buildCorrectUrl(args.id);
            const newsIdMatch = pageUrl.match(/(\d+)-/);
            if (!newsIdMatch) throw new Error(`Не вдалося знайти ID новини в: ${pageUrl}`);
            const newsId = newsIdMatch[1];

            const playlistHtml = await getPlaylistHtml(newsId, pageUrl);
            if (playlistHtml && typeof playlistHtml === 'string') {
                const $ = cheerio.load(playlistHtml);
                const streams = [];
                const playerSources = [];

                let elementsToParse;
                const idParts = args.id.split(':');
                if (idParts.length > 4) { // Це ID епізоду
                    const season = idParts[3];
                    const episode = idParts[4];
                    const episodeTitleRegex = new RegExp(`^${episode}\\s*серія`, 'i');
                    let currentSeason = 0;
                    let foundEpisode = false;

                    $('.playlists-items > ul > li').each((index, element) => {
                        if ($(element).hasClass('playlists-season')) {
                            const seasonMatch = $(element).text().trim().match(/(\d+)\s*Сезон/i);
                            if (seasonMatch) currentSeason = parseInt(seasonMatch[1], 10);
                        } else if ($(element).attr('data-file') && currentSeason.toString() === season) {
                            if ($(element).text().trim().match(episodeTitleRegex)) {
                                elementsToParse = $(element);
                                foundEpisode = true;
                                return false;
                            }
                        }
                    });
                    if (!foundEpisode) elementsToParse = $('li[data-file]');
                } else { // Це фільм
                    elementsToParse = $('li[data-file]');
                }

                elementsToParse.each((index, element) => {
                    let playerPageUrl = $(element).attr('data-file');
                    if (playerPageUrl.startsWith('//')) { playerPageUrl = 'https:' + playerPageUrl; }
                    const streamTitle = $(element).text().trim() || 'Дивитись';
                    playerSources.push({ url: playerPageUrl, title: streamTitle });
                });

                for (const player of playerSources) {
                    try {
                        // --- НОВА ЛОГІКА ВИБОРУ НАЙКРАЩОЇ ЯКОСТІ ---

                        // Змінні для зберігання найкращої якості для ПОТОЧНОГО плеєра
                        let bestStreamForPlayer = null;
                        let maxQuality = 0;

                        const playerPageResponse = await axios.get(player.url, { headers: { 'Referer': UAKINO_BASE_URL } });
                        const masterM3u8Match = playerPageResponse.data.match(/(https?:\/\/[^\s"']+\.m3u8)/);

                        if (masterM3u8Match && masterM3u8Match[1]) {
                            const masterM3u8Url = masterM3u8Match[1];
                            const masterPlaylistResponse = await axios.get(masterM3u8Url, { headers: { 'Referer': player.url } });
                            const lines = masterPlaylistResponse.data.trim().split('\n');

                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                    const qualityUrl = lines[i + 1];
                                    if (!qualityUrl) continue;

                                    let currentQuality = 0;
                                    let qualityLabel = 'SD';
                                    const resolutionMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);

                                    if (resolutionMatch && resolutionMatch[2]) {
                                        const height = parseInt(resolutionMatch[2], 10);
                                        if (!isNaN(height)) {
                                            currentQuality = height;
                                            if (height >= 2160) qualityLabel = '4K';
                                            else if (height >= 1080) qualityLabel = '1080p';
                                            else if (height >= 720) qualityLabel = '720p';
                                            else if (height >= 480) qualityLabel = '480p';
                                            else qualityLabel = `${height}p`;
                                        }
                                    }
                                    // Можна додати резервну логіку, якщо RESOLUTION відсутній

                                    // Якщо знайдена якість краща за попередню найкращу...
                                    if (currentQuality > maxQuality) {
                                        // ...оновлюємо найкращу якість і зберігаємо цей стрім як кандидат
                                        maxQuality = currentQuality;
                                        bestStreamForPlayer = {
                                            name: `UAKINO - ${player.title}`,
                                            title: `▶️ ${qualityLabel}`,
                                            url: qualityUrl.startsWith('http') ? qualityUrl : new URL(qualityUrl, masterM3u8Url).href,
                                            behaviorHints: { headers: { 'Referer': UAKINO_BASE_URL, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' } }
                                        };
                                    }
                                }
                            }
                        }

                        // Додаємо в загальний список ТІЛЬКИ найкращий стрім для цього плеєра
                        if (bestStreamForPlayer) {
                            streams.push(bestStreamForPlayer);
                        }

                    } catch (e) { console.error(`[STREAM] Помилка обробки плеєра ${player.url}: ${e.message}`); }
                }

                if (streams.length > 0) {
                    // Відсортуємо стріми, щоб найкраща якість була першою, якщо є кілька озвучок
                    streams.sort((a, b) => {
                        const qualityA = parseInt(a.title.replace(/\D/g, '')) || 0;
                        const qualityB = parseInt(b.title.replace(/\D/g, '')) || 0;
                        return qualityB - qualityA;
                    });
                    return Promise.resolve({ streams });
                }
            }
            return Promise.resolve({ streams: [] });
        } catch (error) {
            console.error(`[STREAM] Глобальна помилка: ${error.message}`);
            return Promise.resolve({ streams: [] });
        }
    });

    const PORT = 3000;
    serveHTTP(builder.getInterface(), { port: PORT });
    console.log(`\n✅ Додаток запущено! Встановіть його у Stremio за цим посиланням:\nhttp://127.0.0.1:${PORT}/manifest.json`);
}

startAddon();