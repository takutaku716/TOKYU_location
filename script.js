(() => {
    // APIキーとJSONファイルURLは変更しない
    const API_BASE_URL = "https://tokyu-tid.s3.amazonaws.com/";
    const ODPT_API_BASE_URL = "https://api-challenge.odpt.org/api/v4/";
    const ODPT_CONSUMER_KEY = "c2bhb7woxbooca4nxk5be14fx4em8wclha879hahioda3lteq7gmt40ctibsweap";
    const FORMATION_MAP_URL = "./tokyu_formation.json";

    const SVG_NS = "http://www.w3.org/2000/svg";
    const UPDATE_INTERVAL = 15000;
    const VAGUE_DESTINATIONS = ['副都心線', '三田線', '南北線', '相鉄線', '半蔵門線', '元住吉'];

    // キャッシュ関連定数
    const CACHE_KEYS = {
        DEST: 'tokyuDestCache',
        FORM: 'tokyuFormCache'
    };
    const CACHE_EXPIRATION_MS = 5 * 60 * 1000;

    // DOM要素の取得
    const lineSelector = document.getElementById("line-selector");
    const mainMap = document.getElementById("main-map");
    const logDiv = document.getElementById("log");
    const delayStatusSection = document.getElementById("delay-status");
    const ikegamiDelayDiv = document.getElementById('ikegami-delay');
    const tamagawaDelayDiv = document.getElementById('tamagawa-delay');
    const currentLineTrainInfoDiv = document.getElementById('current-line-train-info');

    // 状態変数
    let isUpdating = false;
    let formationData = {}; // tokyu_formation.jsonのデータを格納

    // 路線IDとODPT鉄道IDのマッピング
    const ODPT_RAILWAY_MAP = {
        'toyoko': 'odpt.Railway:Tokyu.Toyoko',
        'meguro': 'odpt.Railway:Tokyu.Meguro',
        'dento': 'odpt.Railway:Tokyu.DenEnToshi',
        'oimachi': 'odpt.Railway:Tokyu.Oimachi',
        'ikegami': 'odpt.Railway:Tokyu.Ikegami',
        'tamagawa': 'odpt.Railway:Tokyu.TokyuTamagawa',
        'setagaya': 'odpt.Railway:Tokyu.Setagaya',
        'shinyokohama': 'odpt.Railway:Tokyu.TokyuShinYokohama',
        'kodomonokuni': 'odpt.Railway:Tokyu.Kodomonokuni'
    };

    /**
     * SVG要素を作成するヘルパー関数。
     * @param {string} tag - 作成するSVG要素のタグ名。
     * @returns {SVGElement} 作成されたSVG要素。
     */
    const createSVG = (tag) => document.createElementNS(SVG_NS, tag);

    /**
     * 運行番号を整形して返す関数。
     * @param {number|string} no - 運行番号。
     * @param {number} actualLineId - 列車の実際の走行路線ID (train.train_line_id)。
     * @param {string} affiliation - 運行会社の所属。
     * @returns {string} 整形された運行番号。
     */
    const getOpNo = (no, actualLineId, affiliation) => {
        const numStr = String(no);

        // 大井町線 (26004), 池上線 (26005), 多摩川線 (26006), 世田谷線 (26007), こどもの国線 (26008)
        // これらの路線はアルファベットを付けず、取得したoperation_numberをそのまま表示
        const LINE_IDS_NO_SUFFIX = [26004, 26005, 26006, 26007, 26008];
        if (LINE_IDS_NO_SUFFIX.includes(actualLineId)) {
            return numStr;
        }

        if (no === 999) return numStr;

        const opchar = { 0: "K", 1: "M", 2: "K", 3: "S", 4: "T", 5: "M", 6: "G", 7: "S", 8: "T", 9: "G" };
        const opSuffix = numStr.padStart(3, '0').slice(-2);

        // 東横線・目黒線・新横浜線 (26001, 26002, 26009)
        const LINE_IDS_TYMG_SHNY = [26001, 26002, 26009];
        if (LINE_IDS_TYMG_SHNY.includes(actualLineId)) {
            return (Math.floor(no / 100) in opchar) ? (opSuffix + opchar[Math.floor(no / 100)]) : opSuffix;
        }

        // 田園都市線 (26003)
        const LINE_ID_DENTO = 26003;
        if (actualLineId === LINE_ID_DENTO) {
            if (no < 100) { // 運行番号が100より小さい場合のみS, K, Tを付与
                return opSuffix + (no < 50 ? "K" : no % 2 === 0 ? "T" : "S");
            } else { // 運行番号が100以上の場合は下2桁のみ
                return opSuffix;
            }
        }

        // その他の路線（基本的にはここには来ないはずだが念のため）
        return (Math.floor(no / 100) in opchar) ? (opSuffix + opchar[Math.floor(no / 100)]) : opSuffix;
    };

    /**
     * `tokyu_formation.json`から編成番号を取得するためのキーを生成する関数。
     * @param {object} train - 列車データオブジェクト。
     * @returns {string|null} formationData内のキー、またはキーを生成できない場合はnull。
     */
    const getFormationMapKey = (train) => {
        const { num_of_cars, affiliation, train_orchestration_number, line_id, train_line_id } = train;
        const actualLineIdForMapKey = train_line_id || line_id;
        const orchNumSuffix = String(train_orchestration_number).padStart(2, '0');

        if (num_of_cars !== null && affiliation !== null && train_orchestration_number !== null) {
            // 東横線 (26001), 目黒線 (26002), 新横浜線 (26009)
            const LINE_IDS_FOR_FORMATION_MAP = [26001, 26002, 26009];
            if (LINE_IDS_FOR_FORMATION_MAP.includes(actualLineIdForMapKey)) {
                // 漢字1文字のaffiliationで明確に判別
                if (affiliation === '急') return `${num_of_cars}急${orchNumSuffix}`;
                if (affiliation === 'み') return `8み${orchNumSuffix}`;
                if (affiliation === '相') return `${num_of_cars}相${orchNumSuffix}`;
                if (affiliation === '副') return `${num_of_cars}副${orchNumSuffix}`;
                if (affiliation === '東') return `10東${orchNumSuffix}`;
                if (affiliation === '西') return `10西${orchNumSuffix}`;
                if (affiliation === '都') return `${num_of_cars}都${orchNumSuffix}`;
                if (affiliation === '南') return `${num_of_cars}南${orchNumSuffix}`;
                if (affiliation === '埼') return `${num_of_cars}埼${orchNumSuffix}`;
            }
        }
        return null;
    };

    /**
     * 列車情報から編成番号を取得するヘルパー関数。
     * 東横線、目黒線、新横浜線の場合、formationDataから編成番号を参照する。
     * 田園都市線は外部APIから、大井町線は両数と列車番号を組み合わせて使用。
     * @param {object} train - 列車データオブジェクト。
     * @param {object} formCache - 編成番号のキャッシュ。
     * @returns {string} 編成番号のテキスト。
     */
    const getFormationNumber = (train, formCache) => {
        let formationText = '';
        const { num_of_cars, affiliation, train_orchestration_number, line_id, train_line_id, operation_number } = train;
        const dir = train.up ? "up" : "down";

        const actualLineIdForFormation = train_line_id || line_id;

        // 定数定義 (関数のスコープ内で一度だけ評価されるようにする)
        const LINE_IDS_FOR_FORMATION_MAP = [26001, 26002, 26009];
        const LINE_ID_DENTO = 26003;
        const LINE_ID_OIMACHI = 26004;

        if (LINE_IDS_FOR_FORMATION_MAP.includes(actualLineIdForFormation)) {
            const mapKey = getFormationMapKey(train);
            if (mapKey) {
                const prefix = mapKey.slice(0, -2);
                const suffix = mapKey.slice(-2);
                if (formationData.tokyu_systems && formationData.tokyu_systems[prefix]) {
                    const data = formationData.tokyu_systems[prefix][suffix];
                    if (data) {
                        formationText = data;
                    }
                }
            }
        }
        // 田園都市線 (26003) の場合、キャッシュから取得したunit_numberを優先
        else if (actualLineIdForFormation === LINE_ID_DENTO) {
            const formCacheKey = `${line_id}-${operation_number}-${train_orchestration_number}-${dir}`;
            if (formCache[formCacheKey] && formCache[formCacheKey].data) {
                const unitNumber = formCache[formCacheKey].data;
                formationText = unitNumber ? `${unitNumber.slice(-4)}F` : '';
            }
        }
        // 大井町線 (26004) の場合、両数と列車番号を組み合わせて使用
        else if (actualLineIdForFormation === LINE_ID_OIMACHI) {
            if (num_of_cars !== null && train_orchestration_number !== null) {
                // "両" の文字を削除
                formationText = `${num_of_cars} ${String(train_orchestration_number).padStart(2, '0')}`;
            }
        }

        // マッピングが見つからない場合のフォールバック
        if (!formationText) {
            formationText = `${num_of_cars || ''}${affiliation || '？'}${train_orchestration_number || ''}`;
            if (affiliation === "") formationText = `${num_of_cars || ''}　${train_orchestration_number || ''}`;
        }
        return formationText;
    };

    /**
     * 路線を変更する関数。
     * @param {string} lineKey - 変更先の路線キー。
     */
    const changeLine = (lineKey) => {
        if (lineKey !== (new URLSearchParams(location.search)).keys().next().value) {
            location.search = lineKey;
        }
    };

    /**
     * 駅IDから接続する路線をマッピングする関数。
     * @param {object} linedata - 路線データ。
     * @returns {object} 駅IDと路線キーの配列のマッピング。
     */
    const createStationToLinesMap = (linedata) => {
        const stationMap = {};
        for (const lineKey in linedata) {
            const line = linedata[lineKey];
            for (const section of line.sections) {
                if (section.station_id) {
                    if (!stationMap[section.station_id]) {
                        stationMap[section.station_id] = [];
                    }
                    stationMap[section.station_id].push(lineKey);
                }
            }
        }
        return stationMap;
    };

    /**
     * 路線選択ボタンを設定する関数。
     * @param {object} linedata - 路線データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     */
    const setupLineSelector = (linedata, currentLineKey) => {
        lineSelector.innerHTML = ''; // 既存のボタンをクリア
        Object.keys(linedata).forEach(key => {
            const line = linedata[key];
            const btn = document.createElement("button");
            btn.className = `line-${line.line_id}-bg`;
            btn.textContent = line.line_name;
            btn.addEventListener("click", () => changeLine(key));
            if (key === currentLineKey) {
                btn.disabled = true;
            }
            lineSelector.appendChild(btn);
        });
    };

    /**
     * 路線図を構築する関数。
     * @param {object} linedata - 路線データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     * @param {object} stationToLinesMap - 駅と路線のマッピング。
     */
    const buildMap = (linedata, currentLineKey, stationToLinesMap) => {
        if (!currentLineKey || !(currentLineKey in linedata)) return;
        mainMap.innerHTML = '';
        const fragment = document.createDocumentFragment();
        const lineSections = linedata[currentLineKey].sections;

        lineSections.forEach(o => {
            if ('station_id' in o) {
                const stationDiv = document.createElement("div");
                stationDiv.className = "map-station";

                const svg = createSVG("svg");
                svg.setAttribute("class", "map-svg");
                svg.setAttribute("width", "192px");
                svg.setAttribute("height", "192px");
                svg.setAttribute("viewBox", "-96 -96 192 192");

                if (o.plats) {
                    o.plats.forEach(p => {
                        const plat = createSVG("rect");
                        plat.setAttribute("class", "station-platform");
                        plat.setAttribute("x", -31.5);
                        plat.setAttribute("y", p * 32 - 9.5);
                        plat.setAttribute("width", 63);
                        svg.appendChild(plat);
                    });
                }
                const text = createSVG("text");
                text.setAttribute("class", "station-name");
                text.setAttribute("x", 0);
                text.setAttribute("y", 6);
                text.textContent = o.station_name;
                svg.appendChild(text);

                if (o.tracks) {
                    const track = createSVG("path");
                    track.setAttribute("class", "track-path");
                    track.setAttribute("d", o.tracks);
                    track.setAttribute("transform", "scale(16)");
                    svg.appendChild(track);
                }
                stationDiv.appendChild(svg);

                if (o.is_transfer_station) {
                    const connectedLines = stationToLinesMap[o.station_id];
                    if (connectedLines && connectedLines.length > 1) {
                        const junctionLinksContainer = document.createElement('div');
                        junctionLinksContainer.className = 'junction-links';
                        connectedLines.forEach(lineKey => {
                            if (lineKey !== currentLineKey) {
                                const targetLine = linedata[lineKey];
                                const linkButton = document.createElement('button');
                                // ここでCSSカスタムプロパティで路線色を直接設定
                                linkButton.style.setProperty('--line-color', `var(--line-color-${targetLine.line_id})`);
                                linkButton.className = `junction-btn`; // クラス名からline-XXXXX-bgを削除
                                linkButton.textContent = targetLine.line_name.replace('線', '');
                                linkButton.onclick = () => changeLine(lineKey);
                                junctionLinksContainer.appendChild(linkButton);
                            }
                        });
                        stationDiv.appendChild(junctionLinksContainer);
                    }
                }

                for (let i = -3; i <= 3; ++i) {
                    if (i === 0) continue;
                    const canv = document.createElement("div");
                    canv.id = `sta${o.station_id}p${i}`;
                    canv.className = "station-track-container";
                    canv.style.top = `${i * 32 + (i < 0 ? 64 : 32) + 48}px`;
                    stationDiv.appendChild(canv);
                }
                fragment.appendChild(stationDiv);
            } else if ('section_id' in o) {
                const sectionDiv = document.createElement("div");
                sectionDiv.className = "map-section";
                const svg = createSVG("svg");
                svg.setAttribute("class", "map-svg");
                svg.setAttribute("width", "64px");
                svg.setAttribute("height", "192px");
                svg.setAttribute("viewBox", "-32 -96 64 192");
                o.section_id.forEach((s, i, a) => {
                    if (s === -1) return;
                    const line = createSVG("line");
                    line.setAttribute("class", "section-line");
                    line.setAttribute("x1", -64);
                    line.setAttribute("y1", (i - a.length / 2) * -32 - 16);
                    line.setAttribute("x2", 64);
                    line.setAttribute("y2", (i - a.length / 2) * -32 - 16);
                    svg.appendChild(line);
                    const canv = document.createElement("div");
                    canv.id = `sec${s}`;
                    canv.className = "train-container";
                    canv.style.top = `${(i - a.length / 2) * -32 + 32 + 48}px`;
                    sectionDiv.appendChild(canv);
                });
                sectionDiv.appendChild(svg);
                fragment.appendChild(sectionDiv);
            }
        });
        mainMap.appendChild(fragment);
    };

    /**
     * ローカルストレージからキャッシュを読み込む関数。
     * @param {string} key - キャッシュキー。
     * @returns {object} キャッシュデータ。
     */
    const loadCache = (key) => {
        try {
            const cached = localStorage.getItem(key);
            return cached ? JSON.parse(cached) : {};
        } catch (e) {
            console.error(`キャッシュの読み込みに失敗 (${key}):`, e);
            if (e.name === 'QuotaExceededError') {
                alert("データ保存容量の制限に達しました。キャッシュをクリアします。再度ページを読み込んでください。");
                localStorage.clear();
                location.reload();
            }
            return {};
        }
    };

    /**
     * ローカルストレージにキャッシュを保存する関数。
     * @param {string} key - キャッシュキー。
     * @param {object} data - 保存するデータ。
     */
    const saveCache = (key, data) => {
        try {
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            console.error(`キャッシュの保存に失敗 (${key}):`, e);
            if (e.name === 'QuotaExceededError') {
                alert("データ保存容量の制限に達しました。キャッシュをクリアします。再度ページを読み込んでください。");
                localStorage.clear();
                location.reload();
            }
        }
    };

    /**
     * 列車の位置情報を更新する関数。
     * @param {object} linedata - 路線データ。
     * @param {object} config - 設定データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     */
    const updateTrainPositions = async (linedata, config, currentLineKey) => {
        if (isUpdating) return;
        isUpdating = true;
        const lineInfo = linedata[currentLineKey];
        if (!lineInfo) {
            isUpdating = false;
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}${lineInfo.uri}.json`);
            if (!response.ok) {
                throw new Error(`列車の走行位置情報の取得に失敗しました: ${response.status}`);
            }
            const data = await response.json();

            const currentLineStationAndSectionIds = new Set();
            lineInfo.sections.forEach(section => {
                if (section.station_id) currentLineStationAndSectionIds.add(section.station_id);
                if (section.section_id && Array.isArray(section.section_id)) {
                    section.section_id.forEach(id => {
                        if (id !== -1) currentLineStationAndSectionIds.add(id);
                    });
                }
            });

            const filteredTrains = data.trains.filter(train => {
                // 開いている路線のline_idと異なる列車は除外
                if (train.line_id !== lineInfo.line_id) return false;
                // 列車が現在の路線の既知の駅/セクション上に存在するかでフィルタリング
                return (train.station_id !== null && currentLineStationAndSectionIds.has(train.station_id)) ||
                       (train.section_id !== null && currentLineStationAndSectionIds.has(train.section_id));
            });

            let destCache = loadCache(CACHE_KEYS.DEST);
            let formCache = loadCache(CACHE_KEYS.FORM);

            // 目的地詳細情報（VAGUE_DESTINATIONS）の取得とキャッシュ
            const destFetchPromises = [];
            for (const train of filteredTrains) {
                const dir = train.up ? "up" : "down";
                const opNum = train.operation_number;
                const currentTrainLineId = train.line_id;
                const trainId = train.train_orchestration_number;
                const cacheKey = `${currentTrainLineId}-${opNum}-${trainId}-${dir}`;

                let destInfo;
                const LINE_IDS_TYMG_SHNY = [26001, 26002, 26009];
                const LINE_IDS_DTOM = [26003, 26004];

                if (LINE_IDS_TYMG_SHNY.includes(currentTrainLineId)) { destInfo = config.dest_names_tymg[train.destination_station_code]; }
                else if (LINE_IDS_DTOM.includes(currentTrainLineId)) { destInfo = config.dest_names_dtom[train.destination_station_code]; }
                const destText = destInfo ? new DOMParser().parseFromString(destInfo, 'text/html').body.textContent : '';

                if (VAGUE_DESTINATIONS.includes(destText)) {
                    const cachedItem = destCache[cacheKey];
                    if (!cachedItem || (Date.now() - cachedItem.timestamp > CACHE_EXPIRATION_MS)) {
                        const kindForUrl = encodeURIComponent(train.kind);
                        let locationParam = '';
                        if (train.section_id !== null) {
                            locationParam = `sections/${train.section_id}`;
                        } else if (train.station_id !== null) {
                            locationParam = `stations/${train.station_id}`;
                        }

                        if (locationParam) {
                            destFetchPromises.push(async () => {
                                const url = `https://timetable-api.tokyuapp.com/lines/${currentTrainLineId}/trains/${opNum}/directions/${dir}/kinds/${kindForUrl}/delays/${train.delay_time}/${locationParam}`;
                                try {
                                    const detailRes = await fetch(url);
                                    if (detailRes.ok) {
                                        const scheduleData = await detailRes.json();
                                        return { cacheKey, data: scheduleData.destination };
                                    }
                                    console.warn(`詳細行き先取得失敗 (HTTP Error ${detailRes.status}): ${cacheKey}`);
                                } catch (err) {
                                    console.error(`詳細行き先取得失敗: ${cacheKey}`, err);
                                }
                                return { cacheKey, data: null };
                            });
                        }
                    }
                }
            }
            const destResults = await Promise.all(destFetchPromises.map(func => func()));
            destResults.forEach(result => {
                if (result && result.cacheKey) {
                    destCache[result.cacheKey] = { data: result.data, timestamp: Date.now() };
                }
            });
            saveCache(CACHE_KEYS.DEST, destCache);

            // 田園都市線（affiliationが空）の編成番号取得とキャッシュ
            const dentoFormFetchPromises = [];
            filteredTrains.forEach(train => {
                const dir = train.up ? "up" : "down";
                const opNum = train.operation_number;
                const currentTrainLineId = train.line_id;
                const trainId = train.train_orchestration_number;
                const cacheKey = `${currentTrainLineId}-${opNum}-${trainId}-${dir}`;

                const LINE_ID_DENTO_FOR_API = 26003; // 田園都市線API呼び出し用ID
                if (currentTrainLineId === LINE_ID_DENTO_FOR_API && train.affiliation === '') {
                    const cachedItem = formCache[cacheKey];
                    if (!cachedItem || (Date.now() - cachedItem.timestamp > CACHE_EXPIRATION_MS)) {
                        dentoFormFetchPromises.push(async () => {
                            const url = `https://train-info.tokyuapp.com/lines/${LINE_ID_DENTO_FOR_API}/trains/${opNum}/directions/${dir}`;
                            try {
                                const detailRes = await fetch(url);
                                if (detailRes.ok) {
                                    const detail = await detailRes.json();
                                    return { cacheKey, data: detail.unit_number };
                                }
                                console.warn(`編成番号取得失敗 (train-info.tokyuapp.com HTTP Error ${detailRes.status}): ${cacheKey}`);
                            } catch (err) {
                                console.error(`編成番号取得失敗 (train-info.tokyuapp.com): ${cacheKey}`, err);
                            }
                            return { cacheKey, data: null };
                        });
                    }
                }
            });
            const dentoFormResults = await Promise.all(dentoFormFetchPromises.map(func => func()));
            dentoFormResults.forEach(result => {
                if (result && result.cacheKey) {
                    formCache[result.cacheKey] = { data: result.data, timestamp: Date.now() };
                }
            });
            saveCache(CACHE_KEYS.FORM, formCache);

            // 列車要素の描画 (既存要素のクリアと再構築)
            document.querySelectorAll('.train-container, .station-track-container').forEach(el => el.innerHTML = '');
            const trainElementsMap = new Map(); // マップを使用して要素を管理

            filteredTrains.forEach(train => {
                const dir = train.up ? "up" : "down";
                const opNum = train.operation_number;
                const currentTrainLineId = train.line_id;
                const actualTrainLineId = train.train_line_id || train.line_id;
                const trainId = train.train_orchestration_number;
                const cacheKey = `${currentTrainLineId}-${opNum}-${trainId}-${dir}`;

                let destHtml = '';
                if (destCache[cacheKey] && destCache[cacheKey].data) {
                    destHtml = destCache[cacheKey].data;
                } else {
                    const LINE_IDS_TYMG_SHNY = [26001, 26002, 26009];
                    const LINE_IDS_DTOM = [26003, 26004];

                    if (LINE_IDS_TYMG_SHNY.includes(currentTrainLineId)) {
                        destHtml = config.dest_names_tymg[train.destination_station_code] || '';
                    } else if (LINE_IDS_DTOM.includes(currentTrainLineId)) {
                        destHtml = config.dest_names_dtom[train.destination_station_code] || '';
                    }
                }

                // 特定の行き先表示の調整
                if (destHtml === '押上[スカイツリー前]') destHtml = '押上';
                if (destHtml === '元町・中華街') destHtml = '元町中華街';

                // 行き先が「東武動物公園」の場合にフォントサイズ調整用クラスを適用
                let destCssClass = '';
                if (destHtml === '東武動物公園') {
                    destCssClass = ' train-dest-long';
                }

                const detailsText = getFormationNumber(train, formCache);
                const trainKindKey = (train.kind ?? '') + (train.train_kind ?? '') || 'null';
                const trainKindHtml = config.train_kinds[trainKindKey] || `<span style="background:red;">${trainKindKey}</span>`;

                const directionSvg = dir === 'up'
                    ? `<div class="train-direction-up"><svg class="train-direction-svg" viewBox="0 0 8 24"><polygon points="8,0 0,12 8,24" /></svg></div>`
                    : `<div class="train-direction-down"><svg class="train-direction-svg" viewBox="0 0 8 24"><polygon points="0,0 8,12 0,24" /></svg></div>`;

                const opNoDisplay = getOpNo(opNum, actualTrainLineId, train.affiliation);

                // 両数表示の決定ロジック
                let displayNumOfCars = train.num_of_cars; // まず元の両数を代入
                const LINE_ID_DENTO_FOR_CARS_CONVERSION = 26003; // 両数変換用の田園都市線ID

                if (actualTrainLineId === LINE_ID_DENTO_FOR_CARS_CONVERSION) {
                    if (train.up === true) { // 田園都市線の上り列車 (渋谷方面) の場合
                        if (!displayNumOfCars && displayNumOfCars !== false) { // 両数が0またはnull/undefinedの場合
                            displayNumOfCars = 10; // 10両と表示 (10両編成なので)
                        } else {
                            displayNumOfCars = null; // 両数が0以外で取得できた場合は省略 (例: 8両編成など)
                        }
                    } else { // 田園都市線の下り列車の場合
                        if (!displayNumOfCars && displayNumOfCars !== false) { // 両数が0またはnull/undefinedの場合
                            displayNumOfCars = 10; // 10両と表示 (10両編成なので)
                        } else {
                            displayNumOfCars = null; // 両数が0以外で取得できた場合は省略 (例: 8両編成など)
                        }
                    }
                }
                // こどもの国線 (ID: 26008) も短編成のため、将来的に同様の変換が必要になる可能性あり

                const tra = document.createElement('div');
                tra.className = `train line-${actualTrainLineId}`; // train_line_idに応じたクラスを付与

                tra.innerHTML = `
                    <div class="train-box"></div>
                    ${directionSvg}
                    ${opNum ? `<div class="train-info train-opno">${opNoDisplay}</div>` : ''}
                    <div class="train-info train-kind">${trainKindHtml}</div>
                    <div class="train-info train-dest${destCssClass}">${destHtml}</div>
                    ${train.delay_time > 0 ? `<div class="train-delay">+${train.delay_time}</div>` : ''}
                    ${displayNumOfCars ? `<div class="train-cars">${displayNumOfCars}両</div>` : ''} ${detailsText.trim() ? `<div class="train-info train-formation-number">${detailsText}</div>` : ''}
                    ${opNum ? `<div class="train-link-wrapper"><a class="train-link" href="https://tokyu-tid.s3.amazonaws.com/train_schedules?lineId=${train.line_id}&operationNumber=${opNum}&direction=${dir}" target="_blank" rel="noopener noreferrer" aria-label="列車番号 ${opNoDisplay} の時刻表"></a></div>` : ''}
                `;

                let elemId;
                if (train.station_id != null) {
                    let trackNumber = train.track_number;
                    // 特定の駅でのトラック番号調整ロジック
                    if (train.station_id === 910) trackNumber = trackNumber > 0 ? 3 - trackNumber : -3 - trackNumber * 2;
                    elemId = `sta${train.station_id}p${trackNumber}`;
                } else if (train.section_id != null) {
                    elemId = `sec${train.section_id}`;
                }

                if (elemId) {
                    if (!trainElementsMap.has(elemId)) {
                        trainElementsMap.set(elemId, document.createDocumentFragment());
                    }
                    trainElementsMap.get(elemId).appendChild(tra);
                } else {
                    // デバッグログは開発時のみ有効に
                    // logDiv.textContent += `Unknown: ${elemId}\t${JSON.stringify(train)}\n`;
                }
            });

            // マップに格納された要素をDOMにまとめて追加
            trainElementsMap.forEach((fragment, id) => {
                const container = document.getElementById(id);
                if (container) container.appendChild(fragment);
            });

        } catch (error) {
            console.error("列車の位置情報の更新に失敗しました:", error);
            // ユーザーへの通知も検討
        } finally {
            isUpdating = false;
        }
    };

    /**
     * 池上線・多摩川線の遅延情報を更新する関数。
     * @param {object} linedata - 路線データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     */
    const updateIkegamiTamagawaDelays = async (linedata, currentLineKey) => {
        ikegamiDelayDiv.style.display = 'none';
        tamagawaDelayDiv.style.display = 'none';

        try {
            const response = await fetch(`${API_BASE_URL}iketama.json`);
            if (!response.ok) throw new Error(`iketama.jsonの取得に失敗しました: ${response.status}`);
            const data = await response.json();

            const selectedLineInfo = linedata[currentLineKey];
            if (!selectedLineInfo) return;

            const LINE_ID_IKEGAMI = 26005;
            const LINE_ID_TAMAGAWA = 26006;

            if (selectedLineInfo.line_id === LINE_ID_IKEGAMI) {
                const upDelay = data.delays.ikegami_up ?? null;
                const downDelay = data.delays.ikegami_down ?? null;
                let text = '池上線: ';
                let className = 'delay-gray';

                if (upDelay !== null && downDelay !== null) {
                    if (upDelay > 0 || downDelay > 0) {
                        text += `上り +${upDelay}分 / 下り +${downDelay}分`;
                        className = 'delay-red';
                    } else {
                        text += '定時運行';
                        className = 'delay-green';
                    }
                } else {
                    text += '遅延情報なし';
                }
                ikegamiDelayDiv.textContent = text;
                ikegamiDelayDiv.className = className;
                ikegamiDelayDiv.style.display = 'block';
            } else if (selectedLineInfo.line_id === LINE_ID_TAMAGAWA) {
                const upDelay = data.delays.tamagawa_up ?? null;
                const downDelay = data.delays.tamagawa_down ?? null;
                let text = '多摩川線: ';
                let className = 'delay-gray';

                if (upDelay !== null && downDelay !== null) {
                    if (upDelay > 0 || downDelay > 0) {
                        text += `上り +${upDelay}分 / 下り +${downDelay}分`;
                        className = 'delay-red';
                    } else {
                        text += '定時運行';
                        className = 'delay-green';
                    }
                } else {
                    text += '遅延情報なし';
                }
                tamagawaDelayDiv.textContent = text;
                tamagawaDelayDiv.className = className;
                tamagawaDelayDiv.style.display = 'block';
            }

        } catch (error) {
            console.error("池上線・多摩川線の遅延情報取得に失敗:", error);
            const selectedLineInfo = linedata[currentLineKey];
            if (selectedLineInfo) {
                if (selectedLineInfo.line_id === 26005) {
                    ikegamiDelayDiv.textContent = '池上線: 遅延情報取得エラー';
                    ikegamiDelayDiv.className = 'delay-gray';
                    ikegamiDelayDiv.style.display = 'block';
                } else if (selectedLineInfo.line_id === 26006) {
                    tamagawaDelayDiv.textContent = '多摩川線: 遅延情報取得エラー';
                    tamagawaDelayDiv.className = 'delay-gray';
                    tamagawaDelayDiv.style.display = 'block';
                }
            }
        }
    };

    /**
     * ODPT運行情報を取得・表示する関数。
     * @param {object} linedata - 路線データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     */
    const updateOdptTrainInformation = async (linedata, currentLineKey) => {
        currentLineTrainInfoDiv.textContent = '運行情報取得中...';
        currentLineTrainInfoDiv.className = 'delay-gray';
        delayStatusSection.style.display = 'block';

        try {
            const response = await fetch(`${ODPT_API_BASE_URL}odpt:TrainInformation?odpt:operator=odpt.Operator:Tokyu&acl:consumerKey=${ODPT_CONSUMER_KEY}`);
            if (!response.ok) {
                throw new Error(`ODPT運行情報APIの取得に失敗しました: ${response.status}`);
            }
            const data = await response.json();

            const selectedLineInfo = linedata[currentLineKey];
            let odptRailwayId = null;

            if (selectedLineInfo && ODPT_RAILWAY_MAP[currentLineKey]) {
                odptRailwayId = ODPT_RAILWAY_MAP[currentLineKey];
            } else {
                for (const key in ODPT_RAILWAY_MAP) {
                    if (linedata[key] && linedata[key].line_id === selectedLineInfo?.line_id) { // selectedLineInfoがnullでないことを確認
                        odptRailwayId = ODPT_RAILWAY_MAP[key];
                        break;
                    }
                }
            }

            let trainInformationText = '運行情報なし';
            let infoStatusClass = 'delay-gray';

            if (odptRailwayId) {
                const trainInfo = data.find(info => info['odpt:railway'] === odptRailwayId);
                if (trainInfo && trainInfo['odpt:trainInformationText']?.ja) {
                    trainInformationText = trainInfo['odpt:trainInformationText'].ja;
                    if (trainInfo['odpt:trainInformationStatus']?.ja === '運行情報あり') {
                        infoStatusClass = 'delay-red';
                    } else {
                        trainInformationText = '平常運転';
                        infoStatusClass = 'delay-green';
                    }
                }
            }

            if (!trainInformationText || trainInformationText.trim() === '') {
                trainInformationText = '運行情報なし';
                infoStatusClass = 'delay-gray';
            }

            currentLineTrainInfoDiv.textContent = `運行情報: ${trainInformationText}`;
            currentLineTrainInfoDiv.className = infoStatusClass;

        } catch (error) {
            console.error("ODPT運行情報取得に失敗:", error);
            currentLineTrainInfoDiv.textContent = '運行情報: 取得エラー';
            currentLineTrainInfoDiv.className = 'delay-gray';
        }
    };

    /**
     * 全ての情報を定期的に更新するメインループ。
     * @param {object} linedata - 路線データ。
     * @param {object} config - 設定データ。
     * @param {string} currentLineKey - 現在選択されている路線キー。
     */
    const startUpdateLoop = (linedata, config, currentLineKey) => {
        // 初回更新
        updateTrainPositions(linedata, config, currentLineKey);
        updateIkegamiTamagawaDelays(linedata, currentLineKey);
        updateOdptTrainInformation(linedata, currentLineKey);

        // 定期更新
        setInterval(() => {
            updateTrainPositions(linedata, config, currentLineKey);
            updateIkegamiTamagawaDelays(linedata, currentLineKey);
            updateOdptTrainInformation(linedata, currentLineKey);
        }, UPDATE_INTERVAL);
    };

    /**
     * アプリケーションの初期化処理。
     */
    const init = async () => {
        try {
            const [lineDataResponse, configResponse, formationMapResponse] = await Promise.all([
                fetch('./linedata.json'),
                fetch('./config.json'),
                fetch(FORMATION_MAP_URL)
            ]);

            if (!lineDataResponse.ok) throw new Error('linedata.jsonの読み込みに失敗しました。');
            if (!configResponse.ok) throw new Error('config.jsonの読み込みに失敗しました。');
            if (!formationMapResponse.ok) throw new Error('tokyu_formation.jsonの読み込みに失敗しました。');

            const linedata = await lineDataResponse.json();
            const config = await configResponse.json();
            formationData = await formationMapResponse.json();

            const params = new URLSearchParams(location.search);
            const currentLineKey = params.keys().next().value || 'toyoko';

            const stationToLinesMap = createStationToLinesMap(linedata);

            setupLineSelector(linedata, currentLineKey);
            buildMap(linedata, currentLineKey, stationToLinesMap);

            startUpdateLoop(linedata, config, currentLineKey);

        } catch (error) {
            console.error("アプリケーションの初期化に失敗しました:", error);
            alert("データの読み込み中にエラーが発生しました。ページをリロードしてください。");
        }
    };

    // DOMContentLoadedイベントで初期化関数を実行
    document.addEventListener("DOMContentLoaded", init);
})();