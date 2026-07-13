(function () {
	'use strict';

	/* ===========================================================================
	 * 0. ENV ADAPTER
	 * ========================================================================= */
	const ENV = (function () {
		const extensionStorage = globalThis.chrome?.storage?.local;

		return {
			async getValue(key, defaultValue) {
				if (extensionStorage?.get) {
					try {
						const result = await extensionStorage.get(key);
						return result?.[key] ?? defaultValue;
					} catch (e) {
						return defaultValue;
					}
				}

				try {
					const raw = window.localStorage.getItem(key);
					return raw === null ? defaultValue : JSON.parse(raw);
				} catch (e) {
					return defaultValue;
				}
			},

			async setValue(key, value) {
				if (extensionStorage?.set) {
					await extensionStorage.set({ [key]: value });
					return;
				}

				window.localStorage.setItem(key, JSON.stringify(value));
			},

			addStyle(css) {
				const style = document.createElement('style');
				style.textContent = css;
				document.documentElement.appendChild(style);
				return style;
			},
		};
	})();

	/* ===========================================================================
	 * 1. CORE
	 * ========================================================================= */
	const Nyatten = {
		name: 'Nyatten',
		env: ENV,
		config: {},
		_modules: [],
		icons: {},
		settingsGroups: [],

		/** 設定のデフォルト値。モジュールごとに config.<moduleId> にまとめる */
		defaultConfig: {
			core: {
				debug: false,
			},
		},

		log(...args) {
			if (this.config?.core?.debug) {
				console.log('[Nyatten]', ...args);
			}
		},

		warn(...args) {
			console.warn('[Nyatten]', ...args);
		},

		/**
		 * 機能モジュールを登録する。
		 * @param {Object} mod
		 * @param {string} mod.id - 一意なID (設定キーやCSSスコープに使う)
		 * @param {string} mod.name - 表示名
		 * @param {string} [mod.description] - モジュールの説明文（設定UIに表示）
		 * @param {Object} [mod.defaultConfig] - このモジュール用のデフォルト設定
		 * @param {string|Object} [mod.icon] - アイコンID（Nyatten.icons のキー）または {type, url?, svg?} 形式のアイコンデータ
		 * @param {boolean} [mod.locked] - true の場合、機能管理から無効化できない
		 * @param {(ctx: Object) => void} mod.init - 有効時に一度だけ呼ばれる初期化関数
		 * @param {(ctx: Object) => void} [mod.onRouteChange] - SPAのルート変化時に呼ばれる
		 */
		registerModule(mod) {
			if (!mod || !mod.id || typeof mod.init !== 'function') {
				this.warn('不正なモジュール登録をスキップしました', mod);
				return;
			}
			if (mod.icon) {
				if (
					typeof mod.icon === 'object' &&
					(mod.icon.type || mod.icon.svg || mod.icon.url)
				) {
					this.icons[mod.id] = mod.icon;
				} else if (
					typeof mod.icon === 'string' &&
					mod.icon.startsWith('<')
				) {
					this.icons[mod.id] = { type: 'svg', svg: mod.icon };
				}
				// 文字列のIDの場合はそのまま icons に参照として使う
			}
			this._modules.push(mod);
		},

		/** モジュールに渡す共通コンテキスト */
		getConfigFor(moduleId) {
			return this.config[moduleId] ?? {};
		},

		async setConfigFor(moduleId, patch) {
			this.config[moduleId] = {
				...(this.config[moduleId] ?? {}),
				...patch,
			};
			await this.env.setValue('nyatten:config', this.config);
			_configChanged = true;
		},

		_makeContext(mod) {
			return {
				nyatten: this,
				env: this.env,
				moduleId: mod.id,
				getConfig: () => this.getConfigFor(mod.id),
				setConfig: async (patch) => this.setConfigFor(mod.id, patch),
				log: (...args) => this.log(`[${mod.id}]`, ...args),
			};
		},

		async _loadConfig() {
			const merged = { ...this.defaultConfig };
			for (const mod of this._modules) {
				if (mod.defaultConfig)
					merged[mod.id] = { ...mod.defaultConfig };
			}
			const saved = await this.env.getValue('nyatten:config', {});
			// 保存値でデフォルトを上書き(浅いマージ)
			for (const key of Object.keys(saved)) {
				merged[key] = { ...merged[key], ...saved[key] };
			}
			this.config = merged;
		},

		/**
		 * SPAのURL変化を検知して 'routeChanged' を発火する。
		 * atten.win は詳細なフレームワークが未確認のため、
		 * pushState/replaceState フックと popstate + MutationObserver の
		 * 併用で頑健に検知する。
		 */
		_watchRouteChange() {
			let lastUrl = location.href;

			const notify = (force = false) => {
				if (location.href === lastUrl && !force) return;
				lastUrl = location.href;
				this.log('route changed ->', lastUrl);
				this._dispatchRouteChange();
			};

			// history API フック
			for (const fnName of ['pushState', 'replaceState']) {
				const original = history[fnName];
				history[fnName] = function (...args) {
					const ret = original.apply(this, args);
					window.dispatchEvent(new Event('nyatten:locationchange'));
					return ret;
				};
			}
			window.addEventListener('popstate', () =>
				window.dispatchEvent(new Event('nyatten:locationchange')),
			);
			window.addEventListener('hashchange', () =>
				window.dispatchEvent(new Event('nyatten:locationchange')),
			);
			window.addEventListener('nyatten:locationchange', notify);

			// SPA内部のDOM更新によるルート遷移も拾うフォールバック
			const routeRoot =
				document.getElementById('root') ||
				document.body ||
				document.documentElement;
			const fallbackObserver = new MutationObserver(
				this.util.debounce(() => {
					notify();
				}, 100),
			);
			fallbackObserver.observe(routeRoot, {
				childList: true,
			});
		},

		_dispatchRouteChange() {
			const ctxCache = new Map();
			for (const mod of this._modules) {
				if (typeof mod.onRouteChange !== 'function') continue;
				if (!ctxCache.has(mod.id))
					ctxCache.set(mod.id, this._makeContext(mod));
				try {
					mod.onRouteChange(ctxCache.get(mod.id));
				} catch (e) {
					this.warn(
						`モジュール "${mod.id}" の onRouteChange でエラー`,
						e,
					);
				}
			}
		},

		async init() {
			await this._loadConfig();
			this.log(
				'起動',
				this._modules.map((m) => m.id),
			);

			this._watchRouteChange();

			for (const mod of this._modules) {
				const modConfig = this.config[mod.id] ?? {};
				if (!mod.locked && modConfig.enabled === false) {
					this.log(`モジュール "${mod.id}" は無効化されています`);
					continue;
				}
				const ctx = this._makeContext(mod);
				try {
					mod.init(ctx);
				} catch (e) {
					this.warn(`モジュール "${mod.id}" の init でエラー`, e);
				}
			}

			// 初回画面を通知（SPA初期状態でもonRouteChangeが動作するように）
			setTimeout(() => this._dispatchRouteChange(), 100);
		},
	};

	/* ===========================================================================
	 * 2. 共通ユーティリティ
	 *    モジュールから ctx.nyatten.util.xxx で使える小道具集。
	 * ========================================================================= */
	Nyatten.util = {
		/**
		 * 要素が出現するまで待つ。SPAでのDOM描画待ちに使う。
		 * @param {string} selector
		 * @param {{ timeout?: number, root?: ParentNode }} [opts]
		 * @returns {Promise<Element>}
		 */
		waitForElement(selector, opts = {}) {
			const { timeout = 10000, root = document } = opts;
			const existing = root.querySelector(selector);
			if (existing) return Promise.resolve(existing);

			return new Promise((resolve, reject) => {
				const observer = new MutationObserver(() => {
					const el = root.querySelector(selector);
					if (el) {
						observer.disconnect();
						resolve(el);
					}
				});
				observer.observe(
					root === document ? document.documentElement : root,
					{
						childList: true,
						subtree: true,
					},
				);
				if (timeout > 0) {
					setTimeout(() => {
						observer.disconnect();
						reject(
							new Error(`waitForElement timeout: ${selector}`),
						);
					}, timeout);
				}
			});
		},

		/** 単純なCSSスコープ付きスタイル注入のヘルパー */
		addStyle(css) {
			const style = document.createElement('style');
			style.textContent = css;
			document.documentElement.appendChild(style);
			return style;
		},

		/** 簡易デバウンス */
		debounce(fn, wait = 200) {
			let t = null;
			return (...args) => {
				clearTimeout(t);
				t = setTimeout(() => fn(...args), wait);
			};
		},

		/** Atten の localStorage キーを安全に読み取る */
		getAttenStorage(key, fallback = null) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : raw;
			} catch {
				return fallback;
			}
		},

		/** Atten の localStorage キーに安全に書き込む */
		setAttenStorage(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (e) {
				Nyatten.warn('localStorage への保存に失敗しました', e);
			}
		},
	};

	// グローバルに公開(モジュールファイルを別リソースとして分けた場合に参照できるように)
	window.Nyatten = Nyatten;

	let lastNyattenRenderedRoute = null;
	let nyattenCardObserver = null;
	let _configChanged = false;

	function pushRouteState(url) {
		history.pushState(null, '', url);
		// history.pushState は _watchRouteChange ですでに nyatten:locationchange を発火するため
		// ここでは二重発火しないよう dispatchRouteChangeEvent を呼ばない。
	}

	function getModuleById(moduleId) {
		return Nyatten._modules.find((m) => m.id === moduleId);
	}

	function renderPanelHeader(title) {
		return (
			'<div class="flex items-center gap-2">' +
			'<a data-nyatten-back-link class="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors" style="width:36px;height:36px" data-slot="icon-button">' +
			'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M19 12H5m7-7-7 7 7 7"/>' +
			'</svg>' +
			'</a>' +
			'<h1 class="text-lg font-bold text-foreground">' +
			escHtml(title) +
			'</h1>' +
			'</div>'
		);
	}

	function renderSearchBox(query) {
		return (
			'<div class="nyatten-search-wrap">' +
			'<svg class="nyatten-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' +
			'</svg>' +
			'<input type="text" data-nyatten-search-box placeholder="モジュールを検索..."' +
			' class="nyatten-search-input" value="' +
			escAttr(query) +
			'" />' +
			'</div>'
		);
	}

	/**
	 * panel内の検索ボックスに入力イベントを配線する。
	 * requestAnimationFrameで間引きつつ data-nyatten-search 属性を更新し、
	 * onSearch(再描画用コールバック)を呼ぶ。renderNyattenIndex/renderModuleTab の
	 * 両方で同一の配線が必要なため共通化する。
	 * @param {HTMLElement} panel
	 * @param {() => void} onSearch
	 */
	function wireSearchBox(panel, onSearch) {
		const searchBox = panel.querySelector('[data-nyatten-search-box]');
		if (!searchBox) return;
		let ticking = false;
		searchBox.addEventListener('input', () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				panel.setAttribute('data-nyatten-search', searchBox.value);
				onSearch();
				ticking = false;
			});
		});
	}

	function scoreModule(query, mod) {
		if (!query) return 0;
		const q = query.toLowerCase();
		const id = (mod.id || '').toLowerCase();
		const name = (mod.name || '').toLowerCase();
		const desc = (mod.description || '').toLowerCase();
		let score = 0;
		if (id === q) score += 4;
		else if (id.includes(q)) score += 2;
		else if (id.startsWith(q.slice(0, 2))) score += 0.5;
		if (name === q) score += 3;
		else if (name.includes(q)) score += 1.5;
		else if (name.startsWith(q.slice(0, 2))) score += 0.5;
		if (desc.includes(q)) score += 1;
		else if (desc.startsWith(q.slice(0, 2))) score += 0.3;
		return score;
	}

	function filterAndSortModules(modules, query) {
		if (!query) {
			return [...modules].sort((a, b) => {
				const nameA = a.name || a.id || '';
				const nameB = b.name || b.id || '';
				return nameA.localeCompare(nameB, 'ja');
			});
		}
		const withScore = modules.map((m) => ({
			mod: m,
			score: scoreModule(query, m),
		}));
		withScore.sort((a, b) => b.score - a.score);
		return withScore.filter(({ score }) => score > 0).map(({ mod }) => mod);
	}

	/* ===========================================================================
	 * 3. モジュール登録はここに追加していく
	 * ========================================================================= */

	/* ---------------------------------------------------------------------------
	 * ここから下に新しいモジュールを追記していく:
	 * ------------------------------------------------------------------------- */

	/* ---------------------------------------------------------------------------
	 * file-preview-plus: 各種ファイルのプレビュー制御と新規形式プレビュー
	 * ------------------------------------------------------------------------- */

	function getFilenameFromUrl(url, fallback) {
		if (!url) return fallback || 'file';
		try {
			const pathname = new URL(url, window.location.origin).pathname;
			const parts = pathname.split('/').filter(Boolean);
			const last = parts[parts.length - 1];
			return last ? decodeURIComponent(last) : fallback || 'file';
		} catch (e) {
			return fallback || 'file';
		}
	}

	async function triggerDirectDownload(btn, url, filename) {
		if (!btn || !url) return;
		const originalOpacity = btn.style.opacity;
		const originalPointerEvents = btn.style.pointerEvents;
		btn.style.opacity = '0.5';
		btn.style.pointerEvents = 'none';
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error('Fetch failed');
			const blob = await response.blob();
			const blobUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = blobUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(blobUrl);
		} catch (e) {
			console.error(
				'[file-preview-plus] Direct download failed, falling back:',
				e,
			);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.target = '_blank';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			btn.style.opacity = originalOpacity;
			btn.style.pointerEvents = originalPointerEvents;
		}
	}

	function replaceWithUnknownCard(element, filename, mime, url) {
		if (element.hasAttribute('data-nyatten-replaced-unknown')) return;
		element.setAttribute('data-nyatten-preview-processed', 'true');
		element.setAttribute('data-nyatten-replaced-unknown', 'true');

		let ext = '';
		if (mime) {
			const mimeLower = mime.toLowerCase();
			if (mimeLower.includes('image/png')) ext = '.png';
			else if (
				mimeLower.includes('image/jpeg') ||
				mimeLower.includes('image/jpg')
			)
				ext = '.jpg';
			else if (mimeLower.includes('image/gif')) ext = '.gif';
			else if (mimeLower.includes('image/svg')) ext = '.svg';
			else if (mimeLower.includes('video/mp4')) ext = '.mp4';
			else if (mimeLower.includes('video/webm')) ext = '.webm';
			else if (
				mimeLower.includes('audio/mpeg') ||
				mimeLower.includes('audio/mp3')
			)
				ext = '.mp3';
			else if (mimeLower.includes('audio/wav')) ext = '.wav';
			else if (mimeLower.includes('audio/ogg')) ext = '.ogg';
			else if (mimeLower.includes('text/plain')) ext = '.txt';
			else if (mimeLower.includes('text/html')) ext = '.html';
			else if (mimeLower.includes('text/css')) ext = '.css';
			else if (
				mimeLower.includes('javascript') ||
				mimeLower.includes('application/x-javascript') ||
				mimeLower.includes('application/javascript')
			)
				ext = '.js';
			else if (mimeLower.includes('markdown')) ext = '.md';
			else if (mimeLower.includes('zip')) ext = '.zip';
		}

		let downloadFilename = filename;
		if (ext && !filename.toLowerCase().endsWith(ext)) {
			downloadFilename = filename + ext;
		}

		const wrapper = document.createElement('div');
		wrapper.className =
			'flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 w-full';
		wrapper.setAttribute('data-post-card-interactive', 'true');
		wrapper.innerHTML =
			'<div class="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4">' +
			'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>' +
			'<path d="M14 2v4a2 2 0 0 0 2 2h4"></path>' +
			'</svg>' +
			'</div>' +
			'<div class="min-w-0 flex-1">' +
			'<p class="truncate text-sm font-medium text-foreground">' +
			escHtml(downloadFilename) +
			'</p>' +
			'<p class="truncate text-xs text-muted-foreground">' +
			escHtml(mime) +
			'</p>' +
			'</div>' +
			'<a href="' +
			escAttr(url) +
			'" download="' +
			escAttr(downloadFilename) +
			'" target="_blank" rel="noreferrer" class="nyatten-download-btn inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-border bg-background text-foreground hover:bg-muted font-semibold whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 size-8 min-h-8 text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:bg-transparent [&_svg:not([class*=\'size-\'])]:size-4" data-slot="icon-button" title="ダウンロード" aria-label="ダウンロード" data-post-card-interactive="true">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4">' +
			'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
			'<polyline points="7 10 12 15 17 10"></polyline>' +
			'<line x1="12" y1="15" x2="12" y2="3"></line>' +
			'</svg>' +
			'</a>';

		element.replaceWith(wrapper);

		const downloadBtn = wrapper.querySelector('.nyatten-download-btn');
		if (downloadBtn) {
			downloadBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				triggerDirectDownload(downloadBtn, url, downloadFilename);
			});
		}
	}

	function estimateFileType(bytes, filename) {
		// 1. Magic numbers for binary files
		if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
			try {
				const textDecoder = new TextDecoder('utf-8');
				const str = textDecoder.decode(bytes.slice(0, 1000));
				if (str.includes('project.json')) return 'sb3';
			} catch (e) {}
			return 'zip';
		}

		// Quick check for common image/document signatures
		if (bytes.length >= 4) {
			if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'binary'; // PNG
			if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'binary'; // JPEG
			if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'binary'; // GIF
			if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'binary'; // PDF
		}

		// 2. Decode as text
		let str = '';
		try {
			// Using fatal: true will throw if the content is not valid UTF-8
			str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch (e) {
			return 'binary';
		}

		// Check for high density of non-printable chars (excluding whitespace)
		let nonPrintable = 0;
		const len = Math.min(bytes.length, 256);
		for (let i = 0; i < len; i++) {
			if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++;
		}
		if (nonPrintable > Math.max(5, len * 0.05)) return 'binary';

		const cleanStr = str.trim();
		if (!cleanStr) return 'text';

		// Parsers
		function canParseAsXML(text) {
			try {
				if (!text.includes('<') || !text.includes('>')) return false;
				const parser = new DOMParser();
				const doc = parser.parseFromString(text, 'text/xml');
				return !doc.querySelector('parsererror');
			} catch (e) {
				return false;
			}
		}

		function canParseAsHTML(text) {
			try {
				if (!text.includes('<') || !text.includes('>')) return false;
				const parser = new DOMParser();
				const doc = parser.parseFromString(text, 'text/html');
				const hasTags = Array.from(doc.body.childNodes).some(n => n.nodeType === 1);
				const hasHead = doc.head.childNodes.length > 0;
				return hasTags || hasHead || /<!DOCTYPE/i.test(text);
			} catch (e) {
				return false;
			}
		}

		function canParseAsCSS(text) {
			try {
				if (!text.includes('{') || !text.includes(':')) return false;
				if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype.replaceSync) {
					const sheet = new CSSStyleSheet();
					const safeText = text.replace(/@import\s+[^;]+;?/g, '');
					sheet.replaceSync(safeText);
					return sheet.cssRules.length > 0;
				}
				return true;
			} catch (e) {
				return false;
			}
		}

		function canParseAsJS(text) {
			try {
				const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
				let testStr = text.replace(/^\s*(import|export)\b[^;]*;?/gm, '');
				new AsyncFunction(testStr);
				return true;
			} catch (e) {
				return false;
			}
		}

		function canParseAsMD(text) {
			try {
				const html = parseMarkdown(text);
				return /<(h[1-6]|ul|ol|pre|blockquote|strong|em|del|code|a\b)/.test(html);
			} catch (e) {
				return false;
			}
		}

		// 3. Strict Signatures & Parsing (HTML / SVG / XML)
		const isXML = canParseAsXML(cleanStr);
		const isHTML = canParseAsHTML(cleanStr);

		if (isXML && !isHTML) return 'xml';
		if (isHTML && !isXML) {
			if (/<svg\b/i.test(cleanStr)) return 'svg';
			return 'html';
		}
		if (isXML && isHTML) {
			if (/<svg\b/i.test(cleanStr)) return 'svg';
			if (/<html|<body|<head|<!DOCTYPE html/i.test(cleanStr)) return 'html';
			if (/<\/?(div|span|p|a|ul|li|b|i|strong|em|table|tr|td|br|hr)\b/i.test(cleanStr)) return 'html';
			return 'xml';
		}

		// 4. JSON
		if (/^[\{\[]/.test(cleanStr)) {
			let isJson = false;
			try {
				JSON.parse(cleanStr);
				isJson = true;
			} catch (e) {
				if (/^\s*(?:\{\s*"|\[\s*(?:\{|\[|")|\[\s*\]|\{\s*\})/.test(cleanStr)) {
					if (!/\b(const|let|function|=>|console\.log)\b/.test(cleanStr)) {
						isJson = true;
					}
				}
			}
			if (isJson) return 'json';
		}

		// 5. Code Parsing and Scoring
		const parsesAsJS = canParseAsJS(cleanStr);
		const parsesAsCSS = canParseAsCSS(cleanStr);
		const parsesAsMD = canParseAsMD(cleanStr);

		const jsScore = 
			(parsesAsJS ? 2 : -10) +
			(cleanStr.match(/^\s*(import\s|export\s|const\s|let\s|var\s|function\s*[\w(]|class\s)/m) ? 3 : 0) +
			(cleanStr.match(/=>/g) ? 1 : 0) +
			(cleanStr.match(/\b(console\.|window\.|document\.|setTimeout|Promise|async\s+function|await\s)/g) ? 2 : 0) +
			(cleanStr.match(/['"]use strict['"]/g) ? 2 : 0);

		const cssScore = 
			(parsesAsCSS ? 3 : -10) +
			(cleanStr.match(/^\s*(@import|@media|@font-face|@keyframes|:root)/m) ? 3 : 0) +
			(cleanStr.match(/(?:^|\})\s*[.#a-zA-Z0-9_-][^{]+\s*\{[\s\S]+?:/m) ? 2 : 0) +
			(cleanStr.match(/!important/g) ? 2 : 0);

		const mdScore = 
			(parsesAsMD ? 2 : 0) +
			(cleanStr.match(/^#+\s+/m) ? 2 : 0) +
			(cleanStr.match(/^[-*+]\s+/m) ? 1 : 0) +
			(cleanStr.match(/^>\s+/m) ? 1 : 0) +
			(cleanStr.match(/`{3,}/g) ? 2 : 0) +
			(cleanStr.match(/\[([^\]]+)\]\(([^)]+)\)/) ? 1 : 0) +
			(cleanStr.match(/^---\s*$/m) ? 2 : 0);

		// Evaluate scores
		const maxScore = Math.max(jsScore, cssScore, mdScore);
		if (maxScore >= 2) {
			if (jsScore === maxScore) return 'js';
			if (cssScore === maxScore) return 'css';
			if (mdScore === maxScore) return 'md';
		}

		// 8. Weak fallback heuristics
		if (isHTML) return 'html';
		if (parsesAsJS && cleanStr.includes('function(')) return 'js';
		if (parsesAsCSS && cleanStr.includes('{') && cleanStr.includes('}')) return 'css';

		return 'text';
	}

	function highlightCode(code, language) {
		let html = escHtml(code);
		const placeholders = [];
		const push = (replacement) => {
			placeholders.push(replacement);
			return `\x01NYA${placeholders.length - 1}NYA\x02`;
		};

		if (language === 'js') {
			html = html
				.replace(
					/(\/\/.*|\/\*[\s\S]*?\*\/)/g,
					(m, p1) => push(`<span style="color: #8b949e; font-style: italic;">${p1}</span>`)
				)
				.replace(
					/("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)/g,
					(m, p1) => push(`<span style="color: #a5d6ff;">${p1}</span>`)
				)
				.replace(
					/\b(const|let|var|function|class|extends|new|return|import|export|from|default|if|else|for|while|switch|case|try|catch|finally|throw|async|await|typeof|instanceof)\b/g,
					(m, p1) => push(`<span style="color: #ff7b72; font-weight: bold;">${p1}</span>`)
				)
				.replace(
					/\b(true|false|null|undefined|NaN)\b/g,
					(m, p1) => push(`<span style="color: #79c0ff;">${p1}</span>`)
				)
				.replace(
					/\b(\d+)\b/g,
					(m, p1) => push(`<span style="color: #d2a8ff;">${p1}</span>`)
				);
		} else if (language === 'css') {
			html = html
				.replace(
					/(\/\*[\s\S]*?\*\/)/g,
					(m, p1) => push(`<span style="color: #8b949e; font-style: italic;">${p1}</span>`)
				)
				.replace(
					/([^{]+)\s*\{/g,
					(m, p1) => `${push(`<span style="color: #79c0ff; font-weight: bold;">${p1}</span>`)} {`
				)
				.replace(
					/([\w-]+)\s*:/g,
					(m, p1) => `${push(`<span style="color: #7ee787;">${p1}</span>`)}:`
				)
				.replace(
					/:([^;}]+)/g,
					(m, p1) => `: ${push(`<span style="color: #a5d6ff;">${p1}</span>`)}`
				);
		} else if (
			language === 'html' ||
			language === 'xml' ||
			language === 'svg'
		) {
			html = html
				.replace(
					/(&lt;!--[\s\S]*?--&gt;)/g,
					(m, p1) => push(`<span style="color: #8b949e; font-style: italic;">${p1}</span>`)
				)
				.replace(
					/(&lt;\/?[a-zA-Z0-9:-]+)(\s|&gt;)/g,
					(m, p1, p2) => `${push(`<span style="color: #7ee787;">${p1}</span>`)}${p2}`
				)
				.replace(
					/(\s[a-zA-Z0-9:-]+=)(["\'][^"\']*["\'])/g,
					(m, p1, p2) => `${p1}${push(`<span style="color: #a5d6ff;">${p2}</span>`)}`
				);
		} else if (language === 'md') {
			html = html
				.replace(
					/(`.*?`)/g,
					(m, p1) => push(`<span style="color: #a5d6ff; background: rgba(110,118,129,0.4); padding: 2px 4px; border-radius: 4px;">${p1}</span>`)
				)
				.replace(
					/^(#+\s+.*)$/gm,
					(m, p1) => push(`<span style="color: #1f6feb; font-weight: bold;">${p1}</span>`)
				)
				.replace(
					/(\*\*.*?\*\*)/g,
					(m, p1) => push(`<span style="color: #ff7b72; font-weight: bold;">${p1}</span>`)
				)
				.replace(
					/(\*.*?\*)/g,
					(m, p1) => push(`<span style="color: #ff7b72; font-style: italic;">${p1}</span>`)
				)
				.replace(
					/(\[.*?\]\(.*?\))/g,
					(m, p1) => push(`<span style="color: #58a6ff;">${p1}</span>`)
				);
		} else if (language === 'json') {
			html = html
				.replace(
					/("[^"\\]*(?:\\.[^"\\]*)*")(\s*:?)/g,
					(m, p1, p2) => {
						if (p2.includes(':')) {
							return `${push(`<span style="color: #79c0ff; font-weight: bold;">${p1}</span>`)}${p2}`;
						}
						return `${push(`<span style="color: #a5d6ff;">${p1}</span>`)}${p2}`;
					}
				)
				.replace(
					/\b(true|false|null)\b/g,
					(m, p1) => push(`<span style="color: #79c0ff;">${p1}</span>`)
				)
				.replace(
					/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
					(m, p1) => push(`<span style="color: #d2a8ff;">${p1}</span>`)
				);
		}

		while (html.includes('\x01NYA')) {
			html = html.replace(/\x01NYA(\d+)NYA\x02/g, (m, idx) => placeholders[idx]);
		}
		return html;
	}

	function renderCodeBlock(code, language, isEnlarged = false) {
		const highlighted = highlightCode(code, language);
		const lines = highlighted.split('\n');

		const rowsHtml = lines
			.map(
				(line, i) =>
					'<tr>' +
					'<td class="nyatten-line-number">' +
					(i + 1) +
					'</td>' +
					'<td class="nyatten-code-line">' +
					(line || ' ') +
					'</td>' +
					'</tr>',
			)
			.join('');

		const extraStyle = isEnlarged ? ' max-height: none; height: 100%; border: none; border-radius: 0;' : '';
		const borderClass = isEnlarged ? '' : ' border border-border';

		return (
			'<div class="nyatten-code-container font-mono text-sm rounded-xl bg-muted/20' + borderClass + '" style="' + extraStyle + '">' +
			'<table class="nyatten-code-table">' +
			'<tbody>' +
			rowsHtml +
			'</tbody>' +
			'</table>' +
			'</div>'
		);
	}

	function parseMarkdown(md, isEnlarged = false) {
		let html = escHtml(md);

		html = html.replace(
			/^######\s+(.*)$/gm,
			'<h6 class="text-xs font-bold mt-2 mb-1">$1</h6>',
		);
		html = html.replace(
			/^#####\s+(.*)$/gm,
			'<h5 class="text-sm font-bold mt-3 mb-1">$1</h5>',
		);
		html = html.replace(
			/^####\s+(.*)$/gm,
			'<h4 class="text-base font-bold mt-3 mb-1">$1</h4>',
		);
		html = html.replace(
			/^###\s+(.*)$/gm,
			'<h3 class="text-lg font-bold mt-4 mb-2">$1</h3>',
		);
		html = html.replace(
			/^##\s+(.*)$/gm,
			'<h2 class="text-xl font-bold mt-4 mb-2 border-b border-border pb-1">$1</h2>',
		);
		html = html.replace(
			/^#\s+(.*)$/gm,
			'<h1 class="text-2xl font-extrabold mt-5 mb-3 border-b border-border pb-1">$1</h1>',
		);

		html = html.replace(
			/\*\*\*(.*?)\*\*\*/g,
			'<strong><em>$1</em></strong>',
		);
		html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
		html = html.replace(/___(.*?)___/g, '<strong><em>$1</em></strong>');
		html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
		html = html.replace(/_(.*?)_/g, '<em>$1</em>');

		html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');

		html = html.replace(
			/```([\s\S]*?)```/g,
			'<pre class="bg-muted/50 p-3 rounded-lg font-mono text-sm overflow-x-auto my-2">$1</pre>',
		);
		html = html.replace(
			/`(.*?)`/g,
			'<code class="bg-muted/50 px-1.5 py-0.5 rounded font-mono text-sm">$1</code>',
		);
		html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, text, url) => {
			const trimmedUrl = url.trim();
			const cleanForCheck = trimmedUrl.toLowerCase().replace(/[\s\x00-\x1F]/g, '');
			const isDangerous =
				cleanForCheck.startsWith('javascript:') ||
				cleanForCheck.startsWith('data:') ||
				cleanForCheck.startsWith('vbscript:');
			if (isDangerous) {
				return `<a href="#" target="_blank" class="text-link hover:underline">${text}</a>`;
			}
			const safeUrl = trimmedUrl.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
			return `<a href="${safeUrl}" target="_blank" class="text-link hover:underline">${text}</a>`;
		});
		html = html.replace(
			/^&gt;\s+(.*)$/gm,
			'<blockquote class="border-l-4 border-muted px-4 py-2 italic my-2 bg-muted/10">$1</blockquote>',
		);

		html = html.replace(
			/^\s*-\s+(.*)$/gm,
			'<li class="list-disc ml-6">$1</li>',
		);
		html = html.replace(
			/^\s*\*\s+(.*)$/gm,
			'<li class="list-disc ml-6">$1</li>',
		);
		html = html.replace(
			/^\s*\d+\.\s+(.*)$/gm,
			'<li class="list-decimal ml-6">$1</li>',
		);

		const blocks = html.split(/\n{2,}/);
		html = blocks
			.map((block) => {
				if (
					block.trim().startsWith('<h') ||
					block.trim().startsWith('<li') ||
					block.trim().startsWith('<blockquote') ||
					block.trim().startsWith('<pre')
				) {
					return block;
				}
				return (
					'<p class="my-2 leading-relaxed">' +
					block.replace(/\n/g, '<br>') +
					'</p>'
				);
			})
			.join('');

		const heightClass = isEnlarged ? 'h-full p-6 sm:p-10' : 'max-h-96 p-4 border border-border rounded-xl';
		return (
			'<div class="nyatten-markdown-preview prose dark:prose-invert ' + heightClass + ' overflow-y-auto bg-card text-foreground text-sm">' +
			html +
			'</div>'
		);
	}

	async function openEnlargedModal(
		format,
		filename,
		url,
		content,
		totalSize,
	) {
		const ext = '.' + format.toLowerCase();
		let downloadFilename = filename;
		if (!filename.toLowerCase().endsWith(ext)) {
			downloadFilename = filename + ext;
		}

		const backdrop = document.createElement('div');
		backdrop.className =
			'nyatten-modal-backdrop fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in';
		backdrop.style.zIndex = '9999';

		const modal = document.createElement('div');
		modal.className =
			'bg-background text-foreground rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl animate-scale-up';
		modal.style.width = '90vw';
		modal.style.maxWidth = '90vw';
		modal.style.height = '90vh';
		modal.style.maxHeight = '90vh';
		modal.style.transformOrigin = 'center';

		let bodyHtml = '';
		let localBlobUrls = [];
		let loadedContent = content;

		if (loadedContent === null && format !== 'sb3') {
			try {
				const response = await fetch(url);
				if (response.ok) {
					const buf = await response.arrayBuffer();
					const bytesData = new Uint8Array(buf);
					const size = buf.byteLength;
					if (size > 512 * 1024) {
						const truncatedBytes = bytesData.slice(0, 512 * 1024);
						const decoder = new TextDecoder('utf-8');
						loadedContent =
							decoder.decode(truncatedBytes) +
							'\n\n... (ファイルサイズが大きいため、プレビューは省略されました。全体を表示するにはダウンロードしてください)';
					} else {
						const decoder = new TextDecoder('utf-8');
						loadedContent = decoder.decode(bytesData);
					}
				} else {
					loadedContent = '読み込みに失敗しました。';
				}
			} catch (e) {
				loadedContent = '読み込みに失敗しました。';
			}
		}

		if (format === 'sb3') {
			let username = '';
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:get-scratch-session',
				});
				if (res && res.ok && res.username) {
					username = res.username;
				}
			} catch (err) {}

			const params = new URLSearchParams({
				project_url: url,
				autoplay: 'true',
			});
			if (username) {
				params.set('username', username);
			}

			bodyHtml =
				'<iframe src="https://turbowarp.org/embed?' +
				params.toString().replace('autoplay=true', 'autoplay') +
				'" class="w-full h-full border-0 bg-background" scrolling="no" allowfullscreen></iframe>';
		} else if (format === 'html') {
			const blob = new Blob([loadedContent], { type: 'text/html' });
			const blobUrl = URL.createObjectURL(blob);
			localBlobUrls.push(blobUrl);
			bodyHtml =
				'<iframe sandbox="allow-scripts" src="' +
				blobUrl +
				'" class="w-full h-full border-0 bg-white"></iframe>';
		} else if (format === 'svg') {
			const blob = new Blob([loadedContent], { type: 'image/svg+xml' });
			const blobUrl = URL.createObjectURL(blob);
			localBlobUrls.push(blobUrl);
			bodyHtml =
				'<div class="w-full h-full flex items-center justify-center p-8 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] bg-[size:20px_20px]">' +
				'<img src="' +
				blobUrl +
				'" class="max-w-full max-h-full object-contain" />' +
				'</div>';
		} else if (format === 'md') {
			bodyHtml =
				'<div class="w-full h-full overflow-hidden bg-card">' +
				parseMarkdown(loadedContent || '', true) +
				'</div>';
		} else if (format === 'js' || format === 'css' || format === 'json' || format === 'xml') {
			bodyHtml =
				'<div class="w-full h-full overflow-hidden bg-muted/10">' +
				renderCodeBlock(loadedContent || '', format, true) +
				'</div>';
		}

		modal.innerHTML =
			'<div class="flex items-center justify-between border-b border-border p-4 bg-muted/10 shrink-0">' +
			'<div class="flex items-center gap-2 min-w-0">' +
			'<div class="min-w-0">' +
			'<p class="truncate text-sm font-bold text-foreground" title="' +
			escAttr(downloadFilename) +
			'">' +
			escHtml(downloadFilename) +
			'</p>' +
			'<p class="text-xs text-muted-foreground uppercase font-mono">' +
			format +
			'</p>' +
			'</div>' +
			'</div>' +
			'<button type="button" class="nyatten-modal-close p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors outline-none">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4">' +
			'<line x1="18" y1="6" x2="6" y2="18"></line>' +
			'<line x1="6" y1="6" x2="18" y2="18"></line>' +
			'</svg>' +
			'</button>' +
			'</div>' +
			'<div class="flex-1 min-h-0 w-full overflow-hidden bg-background">' +
			bodyHtml +
			'</div>';

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		// Disable body scroll
		const originalBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		const closeModal = () => {
			localBlobUrls.forEach((bUrl) => URL.revokeObjectURL(bUrl));
			document.body.style.overflow = originalBodyOverflow;
			backdrop.remove();
			document.removeEventListener('keydown', handleEsc);
		};

		const handleEsc = (e) => {
			if (e.key === 'Escape') closeModal();
		};

		document.addEventListener('keydown', handleEsc);

		backdrop.addEventListener('click', (e) => {
			if (e.target === backdrop) closeModal();
		});

		modal
			.querySelector('.nyatten-modal-close')
			.addEventListener('click', closeModal);
	}

	function renderCustomPreviewCard(
		card,
		format,
		filename,
		url,
		content,
		arrayBuffer,
		totalSize,
	) {
		card.setAttribute('data-nyatten-preview-processed', 'true');
		card.setAttribute('data-nyatten-custom-preview', format);

		const ext = '.' + format.toLowerCase();
		let downloadFilename = filename;
		if (!filename.toLowerCase().endsWith(ext)) {
			downloadFilename = filename + ext;
		}

		const wrapper = document.createElement('div');
		wrapper.className =
			'nyatten-custom-preview-card rounded-2xl border border-border bg-card p-4 space-y-3 w-full';
		wrapper.setAttribute('data-post-card-interactive', 'true');

		let tabs = [];
		let activeTab = '';
		if (format === 'svg' || format === 'md') {
			tabs = ['プレビュー', 'ソースコード'];
			activeTab = 'プレビュー';
		} else if (format === 'html') {
			tabs = ['ソースコード', 'プレビュー'];
			activeTab = 'ソースコード';
		} else if (format === 'sb3') {
			tabs = ['プレイヤー', 'ファイル詳細'];
			activeTab = 'プレイヤー';
		}

		const tabsHtml = tabs
			.map(
				(tab) =>
					'<button type="button" class="nyatten-tab-btn px-3 py-1 text-xs font-semibold rounded-lg transition-colors ' +
					(tab === activeTab
						? 'bg-muted text-foreground'
						: 'text-muted-foreground hover:text-foreground') +
					'" data-tab="' +
					tab +
					'">' +
					tab +
					'</button>',
			)
			.join('');

		const fileIcon =
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4 text-muted-foreground">' +
			'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>' +
			'<path d="M14 2v4a2 2 0 0 0 2 2h4"></path>' +
			'</svg>';

		const headerHtml =
			'<div class="flex items-center justify-between gap-3 pb-2 border-b border-border">' +
			'<div class="flex items-center gap-2 min-w-0">' +
			fileIcon +
			'<div class="min-w-0">' +
			'<p class="truncate text-sm font-semibold text-foreground" title="' +
			escAttr(downloadFilename) +
			'">' +
			escHtml(downloadFilename) +
			'</p>' +
			'<p class="text-xs text-muted-foreground uppercase font-mono">' +
			format +
			'</p>' +
			'</div>' +
			'</div>' +
			'<div class="flex items-center gap-2">' +
			(tabs.length > 0
				? '<div class="flex bg-muted/40 p-0.5 rounded-xl border border-border/50">' +
					tabsHtml +
					'</div>'
				: '') +
			'<a href="' +
			escAttr(url) +
			'" download="' +
			escAttr(downloadFilename) +
			'" target="_blank" rel="noreferrer" class="nyatten-download-btn inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-border bg-background text-foreground hover:bg-muted font-semibold whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 size-8 min-h-8 text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:bg-transparent [&_svg:not([class*=\'size-\'])]:size-4" data-slot="icon-button" title="ダウンロード" aria-label="ダウンロード">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4">' +
			'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
			'<polyline points="7 10 12 15 17 10"></polyline>' +
			'<line x1="12" y1="15" x2="12" y2="3"></line>' +
			'</svg>' +
			'</a>' +
			'</div>' +
			'</div>';

		const bodyHtml =
			'<div class="nyatten-preview-body min-h-24 w-full"></div>';

		wrapper.innerHTML = headerHtml + bodyHtml;
		card.replaceWith(wrapper);

		const previewBody = wrapper.querySelector('.nyatten-preview-body');

		let blobUrls = [];
		const cleanUpBlobUrls = () => {
			blobUrls.forEach((bUrl) => URL.revokeObjectURL(bUrl));
			blobUrls = [];
		};

		const renderTabContent = (tab) => {
			cleanUpBlobUrls();
			if (content === null && format !== 'sb3') {
				const sizeStr = totalSize
					? (totalSize / 1024).toFixed(1) + ' KB'
					: '不明';
				previewBody.innerHTML =
					'<div class="flex flex-col items-center justify-center p-6 border border-border rounded-xl bg-muted/10 w-full min-h-[120px] gap-2">' +
					'<p class="text-xs text-muted-foreground">ファイルサイズが大きいため、自動プレビューは無効化されています (サイズ: ' +
					sizeStr +
					')</p>' +
					'<button type="button" class="nyatten-load-preview-btn px-4 py-2 text-xs font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">' +
					'プレビューを表示' +
					'</button>' +
					'</div>';

				const loadBtn = previewBody.querySelector(
					'.nyatten-load-preview-btn',
				);
				loadBtn.addEventListener('click', async (e) => {
					e.preventDefault();
					e.stopPropagation();

					loadBtn.disabled = true;
					loadBtn.textContent = '読み込み中...';

					try {
						const response = await fetch(url);
						if (!response.ok) throw new Error('Fetch failed');
						const buf = await response.arrayBuffer();
						const bytesData = new Uint8Array(buf);

						arrayBuffer = buf;
						totalSize = buf.byteLength;

						if (totalSize > 512 * 1024) {
							const truncatedBytes = bytesData.slice(
								0,
								512 * 1024,
							);
							const decoder = new TextDecoder('utf-8');
							content =
								decoder.decode(truncatedBytes) +
								'\n\n... (ファイルサイズが大きいため、プレビューは省略されました。全体を表示するにはダウンロードしてください)';
						} else {
							const decoder = new TextDecoder('utf-8');
							content = decoder.decode(bytesData);
						}

						renderTabContent(activeTab || 'ソースコード');
					} catch (err) {
						console.error(err);
						loadBtn.disabled = false;
						loadBtn.textContent = '読み込み失敗 (再試行)';
					}
				});
				return;
			}

			if (tab === 'ソースコード' || tabs.length === 0) {
				previewBody.innerHTML = renderCodeBlock(content || '', format);
			} else if (tab === 'プレビュー') {
				if (format === 'svg') {
					const blob = new Blob([content], { type: 'image/svg+xml' });
					const blobUrl = URL.createObjectURL(blob);
					blobUrls.push(blobUrl);
					previewBody.innerHTML =
						'<div class="flex items-center justify-center p-6 border border-border rounded-xl bg-muted/10 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] bg-[size:16px_16px] w-full min-h-[120px]">' +
						'<img src="' +
						blobUrl +
						'" class="max-w-full h-auto max-h-[480px] object-contain" />' +
						'</div>';
				} else if (format === 'md') {
					previewBody.innerHTML = parseMarkdown(content || '');
				} else if (format === 'html') {
					const blob = new Blob([content], { type: 'text/html' });
					const blobUrl = URL.createObjectURL(blob);
					blobUrls.push(blobUrl);
					previewBody.innerHTML =
						'<iframe sandbox="allow-scripts" src="' +
						blobUrl +
						'" class="w-full border border-border rounded-xl bg-white" style="height: 320px;"></iframe>';
				}
			} else if (tab === 'プレイヤー') {
				if (format === 'sb3') {
					previewBody.innerHTML =
						'<div class="flex justify-center w-full nyatten-sb3-container" style="height: 412px;">' +
						'<div class="nyatten-sb3-placeholder relative flex flex-col items-center justify-center border border-border rounded-xl bg-muted/10 overflow-hidden w-full cursor-pointer group select-none h-full" style="background: linear-gradient(135deg, var(--card, #fff) 0%, rgba(59, 130, 246, 0.03) 100%);">' +
						'<div class="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#1f2937_1px,transparent_1px)] bg-[size:20px_20px] opacity-40"></div>' +
						'<div class="relative flex flex-col items-center gap-4 z-10 transition-transform duration-300 group-hover:scale-105">' +
						'<div class="flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 border border-primary/20 text-primary transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-[0_0_20px_rgba(59,130,246,0.4)]">' +
						'<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="currentColor" class="translate-x-0.5">' +
						'<path d="M8 5v14l11-7z"/>' +
						'</svg>' +
						'</div>' +
						'</div>' +
						'</div>' +
						'</div>';

					const container = previewBody.querySelector(
						'.nyatten-sb3-container',
					);
					const placeholder = container.querySelector(
						'.nyatten-sb3-placeholder',
					);
					placeholder.addEventListener('click', async (e) => {
						e.preventDefault();
						e.stopPropagation();

						let username = '';
						try {
							const res = await chrome.runtime.sendMessage({
								type: 'nyatten:get-scratch-session',
							});
							if (res && res.ok && res.username) {
								username = res.username;
							}
						} catch (err) {}

						const params = new URLSearchParams({
							project_url: url,
							autoplay: 'true',
						});
						if (username) {
							params.set('username', username);
						}

						container.innerHTML =
							'<iframe src="https://turbowarp.org/embed?' +
							params
								.toString()
								.replace('autoplay=true', 'autoplay') +
							'" class="w-full border border-border rounded-xl bg-background h-full" scrolling="no" allowfullscreen></iframe>';
					});
				}
			} else if (tab === 'ファイル詳細') {
				const size =
					totalSize !== null && totalSize !== undefined
						? totalSize
						: arrayBuffer
							? arrayBuffer.byteLength
							: null;
				const sizeStr =
					size !== null ? (size / 1024).toFixed(1) + ' KB' : '不明';
				previewBody.innerHTML =
					'<div class="p-4 border border-border rounded-xl bg-muted/10 space-y-2 text-sm text-foreground">' +
					'<p><strong>ファイル名:</strong> ' +
					escHtml(downloadFilename) +
					'</p>' +
					'<p><strong>ファイル形式:</strong> Scratch 3.0 プロジェクト (.sb3)</p>' +
					'<p><strong>ファイルサイズ:</strong> ' +
					sizeStr +
					'</p>' +
					'<p><strong>URL:</strong> <a href="' +
					escAttr(url) +
					'" target="_blank" class="text-link hover:underline break-all">' +
					escHtml(url) +
					'</a></p>' +
					'</div>';
			}
		};

		renderTabContent(activeTab || 'ソースコード');

		const tabButtons = wrapper.querySelectorAll('.nyatten-tab-btn');
		tabButtons.forEach((btn) => {
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const targetTab = btn.getAttribute('data-tab');

				tabButtons.forEach((b) => {
					b.className =
						'nyatten-tab-btn px-3 py-1 text-xs font-semibold rounded-lg transition-colors ' +
						(b.getAttribute('data-tab') === targetTab
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:text-foreground');
				});

				renderTabContent(targetTab);
			});
		});

		const downloadBtn = wrapper.querySelector('.nyatten-download-btn');
		if (downloadBtn) {
			downloadBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				triggerDirectDownload(downloadBtn, url, downloadFilename);
			});
		}

		wrapper.addEventListener('click', async (e) => {
			// Exclude interactive elements inside the card
			if (
				e.target.closest(
					'button, a, iframe, input, select, textarea, .nyatten-tab-btn, .nyatten-code-container, .nyatten-markdown-preview',
				)
			) {
				return;
			}
			await openEnlargedModal(format, filename, url, content, totalSize);
		});
	}

	async function processCard(card, ctx) {
		if (card.hasAttribute('data-nyatten-preview-processed')) return;
		card.setAttribute('data-nyatten-preview-processed', 'true');

		const downloadLink = card.querySelector('a[download]');
		if (!downloadLink) return;

		const url = downloadLink.href;
		if (!url) return;

		const originalFilename =
			downloadLink.getAttribute('download') ||
			card.querySelector('p.text-sm')?.textContent ||
			'';

		try {
			// Estimate format from file extension first to avoid unnecessary range requests
			let format = '';
			const extMatch = originalFilename.match(/\.([a-zA-Z0-9]+)$/);
			if (extMatch) {
				const ext = extMatch[1].toLowerCase();
				if (ext === 'svg') format = 'svg';
				else if (ext === 'md' || ext === 'markdown') format = 'md';
				else if (ext === 'html' || ext === 'htm') format = 'html';
				else if (ext === 'js' || ext === 'mjs' || ext === 'cjs')
					format = 'js';
				else if (ext === 'css') format = 'css';
				else if (ext === 'sb3') format = 'sb3';
				else if (ext === 'json') format = 'json';
				else if (ext === 'xml') format = 'xml';
			}

			const config = ctx.getConfig();
			const customFormats = ['svg', 'md', 'html', 'js', 'css', 'sb3', 'json', 'xml'];

			let buffer = null;
			let bytes = null;
			let totalSize = null;
			let fullContent = '';

			if (format && customFormats.includes(format)) {
				// If the estimated format is disabled in settings, return immediately
				if (config[format] === false) return;

				if (format === 'sb3') {
					// For sb3, we don't need the full content, so range request is optimal
					const partialResponse = await fetch(url, {
						headers: { Range: 'bytes=0-4095' },
					});
					if (!partialResponse.ok && partialResponse.status !== 206)
						return;

					// Extract total size from headers
					const contentRange =
						partialResponse.headers.get('Content-Range');
					if (contentRange) {
						const match = contentRange.match(/\/(\d+)$/);
						if (match) {
							totalSize = parseInt(match[1], 10);
						}
					}
					if (!totalSize) {
						const contentLength =
							partialResponse.headers.get('Content-Length');
						if (contentLength && partialResponse.status === 200) {
							totalSize = parseInt(contentLength, 10);
						}
					}
				} else {
					// For SVG/Markdown/code previews, fetch the full content directly
					const response = await fetch(url);
					if (!response.ok) return;

					const contentLength =
						response.headers.get('Content-Length');
					let size = 0;
					if (contentLength) {
						size = parseInt(contentLength, 10);
					}

					if (size > 1024 * 1024) {
						totalSize = size;
						fullContent = null;
						buffer = null;
					} else {
						buffer = await response.arrayBuffer();
						bytes = new Uint8Array(buffer);
						totalSize = buffer.byteLength;

						if (totalSize > 1024 * 1024) {
							fullContent = null;
						} else if (totalSize > 128 * 1024) {
							const truncatedBytes = bytes.slice(0, 128 * 1024);
							const decoder = new TextDecoder('utf-8');
							fullContent =
								decoder.decode(truncatedBytes) +
								'\n\n... (ファイルサイズが大きいため、プレビューは省略されました。全体を表示するにはダウンロードしてください)';
						} else {
							const decoder = new TextDecoder('utf-8');
							fullContent = decoder.decode(bytes);
						}
					}
				}
			} else {
				// Fallback: fetch the first 4KB to estimate file type
				const partialResponse = await fetch(url, {
					headers: { Range: 'bytes=0-4095' },
				});
				if (!partialResponse.ok && partialResponse.status !== 206)
					return;

				const partialBuffer = await partialResponse.arrayBuffer();
				const partialBytes = new Uint8Array(partialBuffer);
				if (partialBytes.length === 0) return;

				format = estimateFileType(partialBytes, originalFilename);
				if (!customFormats.includes(format)) return;
				if (config[format] === false) return;

				// Extract total size from headers
				const contentRange =
					partialResponse.headers.get('Content-Range');
				if (contentRange) {
					const match = contentRange.match(/\/(\d+)$/);
					if (match) {
						totalSize = parseInt(match[1], 10);
					}
				}
				if (!totalSize) {
					const contentLength =
						partialResponse.headers.get('Content-Length');
					if (contentLength && partialResponse.status === 200) {
						totalSize = parseInt(contentLength, 10);
					}
				}

				if (partialResponse.status === 200) {
					buffer = partialBuffer;
					bytes = partialBytes;
					if (!totalSize) {
						totalSize = buffer.byteLength;
					}
					if (totalSize > 1024 * 1024) {
						fullContent = null;
					}
				} else {
					if (format === 'sb3') {
						buffer = null;
						bytes = null;
					} else {
						if (totalSize > 1024 * 1024) {
							fullContent = null;
							buffer = null;
						} else {
							const fullResponse = await fetch(url);
							if (!fullResponse.ok) return;

							const contentLength =
								fullResponse.headers.get('Content-Length');
							let size = 0;
							if (contentLength) {
								size = parseInt(contentLength, 10);
							}

							if (size > 1024 * 1024) {
								totalSize = size;
								fullContent = null;
								buffer = null;
							} else {
								buffer = await fullResponse.arrayBuffer();
								bytes = new Uint8Array(buffer);
								if (!totalSize) {
									totalSize = buffer.byteLength;
								}
								if (totalSize > 1024 * 1024) {
									fullContent = null;
								}
							}
						}
					}
				}

				if (format !== 'sb3' && bytes && fullContent !== null) {
					if (totalSize > 128 * 1024) {
						const truncatedBytes = bytes.slice(0, 128 * 1024);
						const decoder = new TextDecoder('utf-8');
						fullContent =
							decoder.decode(truncatedBytes) +
							'\n\n... (ファイルサイズが大きいため、プレビューは省略されました。全体を表示するにはダウンロードしてください)';
					} else {
						const decoder = new TextDecoder('utf-8');
						fullContent = decoder.decode(bytes);
					}
				}
			}

			renderCustomPreviewCard(
				card,
				format,
				originalFilename,
				url,
				fullContent,
				buffer,
				totalSize,
			);
		} catch (e) {
			console.error('[file-preview-plus] processCard error:', e);
		}
	}

	function handleDisabledNativePreviews(ctx, root = document.body) {
		if (!(root instanceof Element)) return;
		const config = ctx.getConfig();
		if (!config.enabled) return;

		// 1. Images
		if (config.image === false) {
			const imageButtons = [];
			const isImgBtn = (el) =>
				el.matches(
					'button.group.relative.cursor-pointer.overflow-hidden.rounded-lg.border.border-border',
				) && el.querySelector('img[src]');
			if (
				isImgBtn(root) &&
				!root.hasAttribute('data-nyatten-preview-processed')
			) {
				imageButtons.push(root);
			}
			imageButtons.push(
				...Array.from(
					root.querySelectorAll(
						'button.group.relative.cursor-pointer.overflow-hidden.rounded-lg.border.border-border:has(img[src]):not([data-nyatten-preview-processed])',
					),
				),
			);

			for (const btn of imageButtons) {
				const img = btn.querySelector('img');
				const url = img.src;
				if (!url || img.hasAttribute('data-twemoji')) continue;
				const filename = getFilenameFromUrl(url, 'image.png');
				replaceWithUnknownCard(btn, filename, 'image/png', url);
			}
		}

		// 2. Videos
		if (config.video === false) {
			const videoContainers = [];
			const isVideoCont = (el) =>
				el.matches(
					'div.relative.overflow-hidden.rounded-lg.border.border-border',
				) &&
				(el.querySelector('video') || el.querySelector('media-player'));
			if (
				isVideoCont(root) &&
				!root.hasAttribute('data-nyatten-preview-processed')
			) {
				videoContainers.push(root);
			}
			videoContainers.push(
				...Array.from(
					root.querySelectorAll(
						'div.relative.overflow-hidden.rounded-lg.border.border-border:has(video):not([data-nyatten-preview-processed]), div.relative.overflow-hidden.rounded-lg.border.border-border:has(media-player):not([data-nyatten-preview-processed])',
					),
				),
			);

			for (const el of videoContainers) {
				const video =
					el.querySelector('video') ||
					el.querySelector('media-player');
				const url = video
					? video.src ||
						(video.querySelector('source') || {}).src ||
						''
					: '';
				if (!url) continue;
				const filename = getFilenameFromUrl(url, 'video.mp4');
				replaceWithUnknownCard(el, filename, 'video/mp4', url);
			}
		}

		// 3. Audio
		if (config.audio === false) {
			const audioContainers = [];
			const isAudioCont = (el) =>
				el.matches(
					'div.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5',
				) &&
				(el.querySelector('audio') ||
					el.querySelector('.media-player-audio'));
			if (
				isAudioCont(root) &&
				!root.hasAttribute('data-nyatten-preview-processed')
			) {
				audioContainers.push(root);
			}
			audioContainers.push(
				...Array.from(
					root.querySelectorAll(
						'div.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:has(audio):not([data-nyatten-preview-processed]), div.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:has(.media-player-audio):not([data-nyatten-preview-processed])',
					),
				),
			);

			for (const el of audioContainers) {
				const audio = el.querySelector('audio');
				const url = audio
					? audio.src ||
						(audio.querySelector('source') || {}).src ||
						''
					: '';
				if (!url) continue;
				const filename = getFilenameFromUrl(url, 'audio.mp3');
				replaceWithUnknownCard(el, filename, 'audio/mpeg', url);
			}
		}

		// 4. Text
		if (config.text === false) {
			const textCards = [];
			const isTextCard = (el) =>
				el.matches(
					'button.flex.w-full.cursor-pointer.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5',
				) && el.querySelector('a[download]');
			if (
				isTextCard(root) &&
				!root.hasAttribute('data-nyatten-preview-processed')
			) {
				textCards.push(root);
			}
			textCards.push(
				...Array.from(
					root.querySelectorAll(
						'button.flex.w-full.cursor-pointer.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:not([data-nyatten-preview-processed])',
					),
				),
			);

			for (const btn of textCards) {
				const downloadLink = btn.querySelector('a[download]');
				if (!downloadLink) continue;
				const url = downloadLink.href;
				const filename =
					downloadLink.getAttribute('download') ||
					btn.querySelector('p.text-sm')?.textContent ||
					'text.txt';
				const mime =
					btn.querySelector('p.text-xs')?.textContent || 'text/plain';
				replaceWithUnknownCard(btn, filename, mime, url);
			}
		}
	}

	function processNodes(root, ctx) {
		if (!(root instanceof Element)) return;

		// Fast-path: if the element is empty (no child elements) and doesn't match any target selectors,
		// it cannot contain or be a preview card, so we skip it immediately.
		if (
			root.firstElementChild === null &&
			!root.matches(
				'div.flex.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5,' +
					'button.group.relative.cursor-pointer.overflow-hidden.rounded-lg.border.border-border,' +
					'div.relative.overflow-hidden.rounded-lg.border.border-border,' +
					'div.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5,' +
					'button.flex.w-full.cursor-pointer.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5',
			)
		) {
			return;
		}

		handleDisabledNativePreviews(ctx, root);

		const selector =
			'div.flex.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5';
		const cards = [];
		const isPreviewCard = (el) =>
			el.matches(selector) && el.querySelector('a[download]');
		if (
			isPreviewCard(root) &&
			!root.hasAttribute('data-nyatten-preview-processed')
		) {
			cards.push(root);
		}
		cards.push(
			...Array.from(
				root.querySelectorAll(
					'div.flex.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:not([data-nyatten-preview-processed])',
				),
			),
		);

		for (const card of cards) {
			processCard(card, ctx);
		}
	}

	Nyatten.registerModule({
		id: 'file-preview-plus',
		name: 'ファイルプレビュー+',
		description:
			'各種ファイルのプレビュー表示やプレビュー機能の有効・無効化を設定できます',
		defaultConfig: {
			enabled: true,
			image: true,
			video: true,
			audio: true,
			text: true,
			svg: true,
			md: true,
			html: true,
			js: true,
			css: true,
			sb3: true,
			json: true,
			xml: true,
		},
		init(ctx) {
			ctx.log('ファイルプレビュー+ モジュール初期化');

			Nyatten.util.addStyle(
				'.nyatten-tab-btn:focus { outline: none; }' +
					'.nyatten-code-container { max-height: 320px; direction: ltr; padding: 12px 0; overflow: auto; }' +
					'.nyatten-code-table { border-collapse: collapse; width: max-content; min-width: 100%; border-spacing: 0; table-layout: auto; margin: 0; padding: 0; }' +
					'.nyatten-line-number { position: sticky; left: 0; z-index: 10; color: var(--text-muted-foreground); text-align: right; padding: 0 12px; user-select: none; font-size: 12px; background-color: var(--muted, #f3f4f6); border-right: 1px solid var(--border, #ddd); min-width: 40px; white-space: nowrap; vertical-align: top; }' +
					'.nyatten-code-line { padding: 0 16px; white-space: pre; font-size: 13px; font-family: monospace; vertical-align: top; text-align: left; }' +
					'.nyatten-markdown-preview p { margin-top: 0.5rem; margin-bottom: 0.5rem; line-height: 1.5; }' +
					'.nyatten-markdown-preview h1 { font-size: 1.5rem; font-weight: 800; margin-top: 1rem; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border, #ddd); padding-bottom: 0.25rem; }' +
					'.nyatten-markdown-preview h2 { font-size: 1.25rem; font-weight: 700; margin-top: 0.875rem; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border, #ddd); padding-bottom: 0.25rem; }' +
					'.nyatten-markdown-preview h3 { font-size: 1.125rem; font-weight: 600; margin-top: 0.75rem; margin-bottom: 0.375rem; }' +
					'.nyatten-markdown-preview code { font-family: monospace; background-color: var(--muted, #f3f4f6); padding: 0.125rem 0.25rem; border-radius: 0.25rem; }' +
					'.nyatten-markdown-preview pre { background-color: var(--muted, #f3f4f6); padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; }' +
					'.nyatten-markdown-preview blockquote { border-left: 4px solid var(--border, #ddd); padding-left: 1rem; color: var(--text-muted-foreground, #888); font-style: italic; }' +
					'.nyatten-markdown-preview ul, .nyatten-markdown-preview ol { margin-left: 1.5rem; margin-top: 0.5rem; margin-bottom: 0.5rem; }' +
					'.nyatten-markdown-preview li { margin-top: 0.25rem; margin-bottom: 0.25rem; }' +
					'.nyatten-custom-preview-card { cursor: pointer; }' +
					'.nyatten-custom-preview-card button, .nyatten-custom-preview-card a, .nyatten-custom-preview-card iframe, .nyatten-custom-preview-card .nyatten-code-container, .nyatten-custom-preview-card .nyatten-markdown-preview { cursor: default; }' +
					'@keyframes nyattenFadeIn { from { opacity: 0; } to { opacity: 1; } }' +
					'@keyframes nyattenScaleUp { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }' +
					'.animate-fade-in { animation: nyattenFadeIn 0.2s ease-out forwards; }' +
					'.animate-scale-up { animation: nyattenScaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards; }',
			);

			// Handle postMessage requests from the turbowarpBridge inside the iframe
			const handleBridgeMessage = async (event) => {
				const origin = event.origin;
				if (!origin) return;
				const isTurbowarp =
					origin === 'https://turbowarp.org' ||
					/^https:\/\/[a-zA-Z0-9-]+\.turbowarp\.org$/.test(origin);
				if (!isTurbowarp) return;

				const msg = event.data;
				if (msg && msg.type === 'nyatten:fetch-asset') {
					const { requestId, url } = msg;
					const sourceFrame = event.source;
					if (!sourceFrame) return;

					try {
						let parsedUrl;
						try {
							parsedUrl = new URL(url);
						} catch (e) {
							throw new Error('Invalid URL format');
						}

						if (
							parsedUrl.protocol !== 'http:' &&
							parsedUrl.protocol !== 'https:'
						) {
							throw new Error('Unsupported protocol');
						}

						const isAttenDomain =
							parsedUrl.hostname === 'atten.win' ||
							parsedUrl.hostname.endsWith('.atten.win');
						if (!isAttenDomain) {
							throw new Error('Unauthorized domain');
						}

						const path = parsedUrl.pathname.toLowerCase();
						const isSensitive =
							path.startsWith('/api/') ||
							path.startsWith('/oauth/') ||
							path.startsWith('/signin') ||
							path.startsWith('/signup') ||
							path.startsWith('/settings') ||
							path.startsWith('/admin') ||
							path.includes('../');
						if (isSensitive) {
							throw new Error(
								'Access to sensitive endpoint is blocked',
							);
						}

						const res = await fetch(url);
						if (res.ok) {
							const mime = res.headers.get('Content-Type');
							const buffer = await res.arrayBuffer();
							sourceFrame.postMessage(
								{
									type: 'nyatten:fetch-asset-response',
									requestId,
									success: true,
									data: buffer,
									mime: mime,
									status: res.status,
								},
								event.origin,
								[buffer],
							);
						} else {
							sourceFrame.postMessage(
								{
									type: 'nyatten:fetch-asset-response',
									requestId,
									success: false,
									status: res.status,
								},
								event.origin,
							);
						}
					} catch (err) {
						console.error(
							'[file-preview-plus] Bridge fetch failed:',
							err,
						);
						sourceFrame.postMessage(
							{
								type: 'nyatten:fetch-asset-response',
								requestId,
								success: false,
							},
							event.origin,
						);
					}
				}
			};

			window.addEventListener('message', handleBridgeMessage);

			const config = ctx.getConfig();
			if (config.enabled !== false) {
				handleDisabledNativePreviews(ctx, document.body);

				const cards = document.querySelectorAll(
					'div.flex.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:not([data-nyatten-preview-processed])',
				);
				for (const card of cards) {
					processCard(card, ctx);
				}
			}

			// MutationObserverによる監視
			const observer = new MutationObserver((mutations) => {
				const conf = ctx.getConfig();
				if (conf.enabled === false) return;

				const addedElements = [];
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (node instanceof Element) {
							addedElements.push(node);
						}
					}
				}
				if (addedElements.length === 0) return;
				const uniqueAdded = addedElements.filter((el) => {
					return !addedElements.some(
						(other) => other !== el && other.contains(el),
					);
				});
				for (const el of uniqueAdded) {
					processNodes(el, ctx);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			this._observer = observer;
		},
		onRouteChange(ctx) {
			const config = ctx.getConfig();
			if (config.enabled === false) return;

			setTimeout(() => {
				handleDisabledNativePreviews(ctx, document.body);

				const cards = document.querySelectorAll(
					'div.flex.items-center.gap-3.rounded-lg.border.border-border.bg-muted\\/30.px-3.py-2\\.5:not([data-nyatten-preview-processed])',
				);
				for (const card of cards) {
					processCard(card, ctx);
				}
			}, 200);
		},
	});


	/* ---------------------------------------------------------------------------
	 * ここから下に新しいモジュールを追記していく:
	 * ------------------------------------------------------------------------- */

	/* ---------------------------------------------------------------------------
	 * active-indicator: アクティブインジケータ
	 * ------------------------------------------------------------------------- */

	const ACTIVE_EPOCH = 1767225600000; // 2026-01-01 00:00:00 UTC
	const ACTIVE_START_MARKER = '\u3164';
	const ACTIVE_PRIVATE_MARKER = '\u115F';
	const ACTIVE_CHAR_MAP = {
		'0': '\u1160',
		'1': '\uffa0',
		'2': '\u3164'
	};
	const ACTIVE_REV_MAP = {
		'\u1160': '0',
		'\uffa0': '1',
		'\u3164': '2'
	};

	function encodeTimestamp(isPrivate) {
		if (isPrivate) {
			return ACTIVE_START_MARKER + ACTIVE_PRIVATE_MARKER;
		}
		const minutes = Math.floor((Date.now() - ACTIVE_EPOCH) / 60000);
		const base3 = minutes.toString(3);
		let encoded = ACTIVE_START_MARKER;
		for (let char of base3) {
			encoded += ACTIVE_CHAR_MAP[char];
		}
		return encoded;
	}

	function decodeStatus(displayName) {
		if (!displayName || !displayName.startsWith(ACTIVE_START_MARKER)) {
			return null;
		}
		if (displayName.charAt(1) === ACTIVE_PRIVATE_MARKER) {
			return { isPrivate: true };
		}
		let base3Str = '';
		let i = 1;
		while (i < displayName.length) {
			const char = displayName.charAt(i);
			if (ACTIVE_REV_MAP[char] !== undefined) {
				base3Str += ACTIVE_REV_MAP[char];
				i++;
			} else {
				break;
			}
		}
		if (base3Str.length === 0) {
			return null;
		}
		const minutes = parseInt(base3Str, 3);
		const timestamp = minutes * 60000 + ACTIVE_EPOCH;
		return { isPrivate: false, timestamp };
	}

	function stripTimestamp(displayName) {
		if (!displayName) return '';
		return displayName.replace(/[\u3164][\u115F\u1160\uffa0\u3164]*/g, '');
	}

	Nyatten.registerModule({
		id: 'active-indicator',
		name: 'アクティブインジケータ',
		description: '有効時2分30秒おきにユーザー名の先頭に不可視文字でタイムスタンプを極力圧縮して挿入し、オンライン状態の点を表示します。',
		defaultConfig: {
			enabled: true,
			privateStatus: false,
		},
		init(ctx) {
			ctx.log('active-indicator モジュール初期化');
			this._ctx = ctx;
			this._timer = null;
			this._observer = null;
			this._dotTimer = null;
			this._titleObserver = null;

			// スタイルの注入
			Nyatten.util.addStyle(
				'.nyatten-active-dot {' +
				'  width: 8px;' +
				'  height: 8px;' +
				'  border-radius: 50%;' +
				'  display: inline-block;' +
				'  margin-left: 6px;' +
				'  vertical-align: middle;' +
				'  flex-shrink: 0;' +
				'}'
			);

			// 初回実行と定期実行 (2分30秒 = 150000msおき)
			this._updateStatus();
			this._timer = setInterval(() => {
				this._updateStatus();
			}, 150000);

			// ページタイトルの監視とクリーンアップ
			const titleEl = document.querySelector('title');
			if (titleEl) {
				this._titleObserver = new MutationObserver(() => {
					if (document.title && document.title.includes(ACTIVE_START_MARKER)) {
						document.title = stripTimestamp(document.title);
					}
				});
				this._titleObserver.observe(titleEl, {
					childList: true,
					characterData: true,
					subtree: true,
				});
			}
			if (document.title && document.title.includes(ACTIVE_START_MARKER)) {
				document.title = stripTimestamp(document.title);
			}

			// DOMのスキャンと監視
			this._scan(document.body);
			
			const debouncedScan = Nyatten.util.debounce(() => {
				this._scan(document.body);
			}, 100);

			this._observer = new MutationObserver(() => {
				debouncedScan();
			});
			this._observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true,
			});

			// ドット色の定期更新タイマー (10秒おき)
			this._startDotUpdater();
		},

		onRouteChange(ctx) {
			this._ctx = ctx;
			this._scan(document.body);
		},

		_startDotUpdater() {
			this._dotTimer = setInterval(() => {
				const dots = document.querySelectorAll('.nyatten-active-dot');
				for (const dot of dots) {
					this._updateDotColor(dot);
				}
			}, 10000);
		},

		_updateDotColor(dot) {
			const now = Date.now();
			if (dot.dataset.isPrivate === 'true') {
				dot.style.backgroundColor = '#f97316'; // orange
				dot.title = '非公開';
			} else {
				const ts = Number(dot.dataset.timestamp);
				if (!isNaN(ts)) {
					const diff = now - ts;
					if (diff <= 300000) {
						dot.style.backgroundColor = '#22c55e'; // green
						dot.title = 'オンライン';
					} else {
						dot.style.backgroundColor = '#9ca3af'; // grey
						const months = Math.floor(diff / 2592000000);
						const days = Math.floor((diff % 2592000000) / 86400000);
						const hours = Math.floor((diff % 86400000) / 3600000);
						const minutes = Math.floor((diff % 3600000) / 60000);
						const seconds = Math.floor((diff % 60000) / 1000);

						const parts = [];
						if (months > 0) parts.push(`${months}m`);
						if (days > 0) parts.push(`${days}d`);
						if (hours > 0) parts.push(`${hours}h`);
						if (minutes > 0) parts.push(`${minutes}m`);
						if (seconds > 0) parts.push(`${seconds}s`);

						if (parts.length === 0) {
							parts.push('0s');
						}

						dot.title = `オフライン(${parts.join('')})`;
					}
				}
			}
		},

		_scan(root) {
			if (!root) return;

			// テキストノードのスキャン
			const walker = document.createTreeWalker(
				root,
				NodeFilter.SHOW_TEXT,
				{
					acceptNode: (node) => {
						if (node.nodeValue && node.nodeValue.includes(ACTIVE_START_MARKER)) {
							return NodeFilter.FILTER_ACCEPT;
						}
						return NodeFilter.FILTER_REJECT;
					},
				},
			);
			const textNodes = [];
			let current;
			while ((current = walker.nextNode())) {
				textNodes.push(current);
			}

			for (const textNode of textNodes) {
				const fullText = textNode.nodeValue;
				const status = decodeStatus(fullText);
				if (status) {
					const cleanText = stripTimestamp(fullText);
					textNode.nodeValue = cleanText;

					const next = textNode.nextSibling;
					if (next && next.classList && next.classList.contains('nyatten-active-dot')) {
						next.dataset.timestamp = status.timestamp || '';
						next.dataset.isPrivate = status.isPrivate ? 'true' : 'false';
						this._updateDotColor(next);
					} else {
						const dot = document.createElement('span');
						dot.className = 'nyatten-active-dot';
						dot.dataset.timestamp = status.timestamp || '';
						dot.dataset.isPrivate = status.isPrivate ? 'true' : 'false';
						this._updateDotColor(dot);
						textNode.after(dot);
					}
				}
			}

			// 入力欄やテキストエリアのスキャン (表示名編集欄などに入り込まないように)
			const inputs = document.querySelectorAll('input[type="text"], textarea');
			for (const input of inputs) {
				if (input.value && input.value.startsWith(ACTIVE_START_MARKER)) {
					input.value = stripTimestamp(input.value);
				}
			}
		},

		_getAttenCsrfToken() {
			const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
			return match ? decodeURIComponent(match[1]) : null;
		},

		async _ensureAttenCsrfToken() {
			let token = this._getAttenCsrfToken();
			if (token) return token;
			try {
				await fetch('https://api.atten.win/csrf-token', {
					credentials: 'include',
				});
			} catch (e) {
				this._ctx.nyatten.warn('csrf-tokenの取得に失敗しました', e);
			}
			return this._getAttenCsrfToken();
		},

		async _request(method, path, body, _isRetry = false) {
			const csrfToken = await this._ensureAttenCsrfToken();
			const headers = {
				Accept: 'application/json',
				'X-Client-Id': 'atten-web',
			};
			if (method !== 'GET') headers['Content-Type'] = 'application/json';
			if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

			const actingUserId = window.localStorage.getItem('atten.acting_user_id');
			if (actingUserId) {
				headers['X-Acting-User-Id'] = actingUserId;
			}

			const res = await fetch('https://api.atten.win' + path, {
				method,
				credentials: 'include',
				headers,
				body: method === 'GET' ? undefined : JSON.stringify(body),
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || json?.ok === false) {
				const code = json?.code;
				if (method !== 'GET' && code === 'csrf_validation_failed' && !_isRetry) {
					return this._request(method, path, body, true);
				}
				const err = new Error(code || `HTTP ${res.status}`);
				err.body = json;
				throw err;
			}
			return json?.data ?? json;
		},

		_apiGet(path) {
			return this._request('GET', path);
		},

		_apiPatch(path, body) {
			return this._request('PATCH', path, body);
		},

		async _updateStatus() {
			const config = this._ctx.getConfig();
			if (!config.enabled) return;

			const actingUserId = window.localStorage.getItem('atten.acting_user_id');
			if (!actingUserId) {
				this._ctx.log('未ログインまたは操作アカウントがありません');
				return;
			}

			try {
				const data = await this._apiGet('/session/users');
				if (!Array.isArray(data)) return;
				const activeEntry = data.find((e) => e?.user?.id === actingUserId);
				if (!activeEntry || !activeEntry.user) return;

				const scratchName = activeEntry.user.scratch_name;
				const currentDisplayName = activeEntry.user.display_name || '';

				const cleanName = stripTimestamp(currentDisplayName);
				const prefix = encodeTimestamp(config.privateStatus);
				const newDisplayName = prefix + cleanName;

				if (newDisplayName !== currentDisplayName) {
					this._ctx.log('ユーザー名を更新します:', cleanName, '->', newDisplayName);
					await this._apiPatch(`/users/${scratchName}`, {
						display_name: newDisplayName,
					});
					this._ctx.log('ユーザー名を更新しました');
				} else {
					this._ctx.log('ユーザー名は最新です:', newDisplayName);
				}
			} catch (e) {
				this._ctx.nyatten.warn('アクティブインジケータの更新に失敗しました:', e);
			}
		}
	});

	/* ---------------------------------------------------------------------------
	 * settings-panel: Atten の設定画面に Nyatten タブを追加するモジュール
	 * ------------------------------------------------------------------------- */

	Nyatten.registerModule({
		id: 'settings-panel',
		name: 'Nyatten設定',
		description: 'Attenの設定画面にNyattenの設定を追加',
		defaultConfig: { enabled: true },
		locked: true,
		init(ctx) {
			ctx.log('settings-panel モジュール初期化');
			Nyatten.util.addStyle(
				'.nyatten-search-wrap { position: relative; }' +
					'.nyatten-search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-muted-foreground, #888); pointer-events: none; }' +
					'.nyatten-search-input { width: 100%; border-radius: 16px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); padding: 8px 16px 8px 38px; font-size: 14px; color: var(--foreground, #000); outline: none; box-sizing: border-box; }' +
					'.nyatten-search-input::placeholder { color: var(--text-muted-foreground, #888); }' +
					'.nyatten-search-input:focus { outline: 2px solid var(--primary, #3b82f6); outline-offset: -1px; }',
			);
		},
		onRouteChange(ctx) {
			const config = ctx.getConfig();
			if (!config.enabled) return;

			const path = location.pathname;
			const hash = location.hash;

			if (path !== '/settings') {
				cleanupNyattenPanel();
				if (_configChanged) {
					_configChanged = false;
					location.reload();
				}
				return;
			}

			if (hash === '#nyatten' || hash.startsWith('#nyatten:')) {
				cleanupNyattenPanel();
				renderNyattenSettings(ctx);
			} else if (!hash) {
				cleanupNyattenPanel();
				injectNyattenCard(ctx);
			} else {
				cleanupNyattenPanel();
			}
		},
	});

	Nyatten.registerModule({
		id: 'ngcat',
		name: 'NGCat',
		description: '設定したNGワードを含むポストを自動的に非表示にします',
		defaultConfig: { enabled: false, words: '' },
		init(ctx) {
			ctx.log('NGCat モジュール初期化');
			this._ctx = ctx;
			this._words = [];
			this._scanTimer = null;
			this._observer = null;

			this._refreshWords();
			this._scheduleScan();

			const root = document.body || document.documentElement;
			if (root) {
				this._observer = new MutationObserver((mutations) => {
					if (!this._ctx?.getConfig?.()?.enabled) return;
					if (!this._words.length) return;

					const addedElements = [];
					for (const mutation of mutations) {
						for (const node of mutation.addedNodes) {
							if (node instanceof Element) {
								addedElements.push(node);
							}
						}
					}
					if (addedElements.length === 0) return;
					const uniqueAdded = addedElements.filter((el) => {
						return !addedElements.some(
							(other) => other !== el && other.contains(el),
						);
					});
					for (const el of uniqueAdded) {
						this._scan(el);
					}
				});
				this._observer.observe(root, {
					childList: true,
					subtree: true,
				});
			}
		},
		onRouteChange(ctx) {
			this._ctx = ctx;
			this._refreshWords();
			this._scheduleScan();
		},
		_refreshWords() {
			const config = this._ctx?.getConfig?.() ?? {};
			const raw = config.words || '';
			const newWords = raw
				.split(/\r?\n|,/)
				.map((word) => word.trim())
				.filter(Boolean);

			const prev = this._words || [];
			const changed =
				prev.length !== newWords.length ||
				prev.some((w, i) => w !== newWords[i]);

			this._words = newWords;
			if (changed) {
				const selector = this._getTargetSelector();
				const elements = document.querySelectorAll(selector);
				for (const el of elements) {
					el.removeAttribute('data-nyatten-ngcat-scanned');
					this._show(el);
				}
				this._scheduleScan();
			}
		},
		_scheduleScan() {
			clearTimeout(this._scanTimer);
			this._scanTimer = setTimeout(() => {
				this._scan(document.body || document.documentElement);
			}, 150);
		},
		_isSettingsElement(el) {
			return !!el.closest(
				'[data-nyatten-settings-panel], [data-nyatten-settings-card], [data-nyatten-module], [data-nyatten-group]',
			);
		},
		_getTargetSelector() {
			return "article, [role='article'], [data-post-card], [data-testid*='post'], [data-testid*='timeline'], [data-testid*='feed']";
		},
		_containsNgWord(text) {
			const normalized = String(text || '').toLowerCase();
			return this._words.some((word) =>
				normalized.includes(word.toLowerCase()),
			);
		},
		_hide(el) {
			if (!el || !(el instanceof Element)) return;
			(el.parentElement || el).style.display = 'none';
		},
		_show(el) {
			if (!el || !(el instanceof Element)) return;
			(el.parentElement || el).style.display = '';
		},
		_scan(root) {
			if (!this._ctx?.getConfig?.()?.enabled) return;
			if (!root) return;

			const selector = this._getTargetSelector();
			if (!this._words.length) return;

			// Optimization: only select elements that haven't been scanned for NG words yet
			const unscannedSelector = selector
				.split(',')
				.map((s) => `${s.trim()}:not([data-nyatten-ngcat-scanned])`)
				.join(', ');

			const targets = new Set();

			// If root itself matches the selector, check it too
			const rootSelector = selector
				.split(',')
				.map((s) => s.trim())
				.join(', ');
			if (
				root instanceof Element &&
				root.matches(rootSelector) &&
				!root.hasAttribute('data-nyatten-ngcat-scanned') &&
				!this._isSettingsElement(root)
			) {
				targets.add(root);
			}

			(root.querySelectorAll(unscannedSelector) || []).forEach((el) => {
				if (!this._isSettingsElement(el)) targets.add(el);
			});

			for (const el of targets) {
				el.setAttribute('data-nyatten-ngcat-scanned', 'true');
				const text = el.textContent || '';
				if (this._containsNgWord(text)) {
					this._hide(el);
				}
			}
		},
	});

	Nyatten.registerModule({
		id: 'nyax-emoji',
		name: 'NyaXEmoji',
		description: 'AttenでもNyaXEmoji',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('NyaXEmoji モジュール初期化');
			this._emojiIds = new Set();
			this._emojiObserver = null;
			this._emojiListUrl = 'https://ntnekochat.pages.dev/emoji/list.json';
			this._emojiImageUrl = 'https://ntnekochat.pages.dev/emoji/';
			this._emojiRegex = null;
			this._ignoredSelectors = [
				'SCRIPT',
				'STYLE',
				'TEXTAREA',
				'OPTION',
				'INPUT',
				'BUTTON',
			];

			this.loadEmojiList().then(() => {
				this.processEmojiReplacements(document.body);
			});

			const observer = new MutationObserver((mutations) => {
				if (!this._emojiIds.size) return;
				const addedElements = [];
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (node instanceof Element) {
							addedElements.push(node);
						}
					}
				}
				if (addedElements.length === 0) return;
				const uniqueAdded = addedElements.filter((el) => {
					return !addedElements.some(
						(other) => other !== el && other.contains(el),
					);
				});
				for (const el of uniqueAdded) {
					this.processEmojiReplacements(el);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			this._emojiObserver = observer;
		},
		async onRouteChange(ctx) {
			const config = ctx.getConfig();
			if (!config.enabled) return;
			await this.loadEmojiList();
			this.processEmojiReplacements(document.body);
		},
		async loadEmojiList() {
			if (this._emojiListPromise) return this._emojiListPromise;
			this._emojiListPromise = fetch(this._emojiListUrl, {
				cache: 'no-cache',
			})
				.then(async (res) => {
					if (!res.ok) {
						throw new Error(
							'NyaXEmoji list fetch failed: ' + res.status,
						);
					}
					return res.json();
				})
				.then((payload) => {
					const ids = new Set();
					if (Array.isArray(payload)) {
						for (const item of payload) {
							if (typeof item === 'string') ids.add(item);
							else if (item && typeof item.id === 'string')
								ids.add(item.id);
						}
					} else if (payload && typeof payload === 'object') {
						for (const key of Object.keys(payload)) {
							ids.add(key);
						}
					}
					this._emojiIds = ids;

					const sortedIds = Array.from(ids).sort(
						(a, b) => b.length - a.length,
					);
					if (sortedIds.length > 0) {
						const escapeRegExp = (string) => {
							return string.replace(
								/[.*+?^${}()|[\]\\]/g,
								'\\$&',
							);
						};
						const pattern = sortedIds.map(escapeRegExp).join('|');
						this._emojiRegex = new RegExp(`_(${pattern})_`, 'g');
					} else {
						this._emojiRegex = null;
					}

					return ids;
				})
				.catch((error) => {
					Nyatten.warn(
						'NyaXEmoji list の読み込みに失敗しました',
						error,
					);
					return this._emojiIds;
				});
			return this._emojiListPromise;
		},
		buildEmojiImage(id) {
			const img = document.createElement('img');
			img.src = this._emojiImageUrl + encodeURIComponent(id) + '.svg';
			img.alt = `_${id}_`;
			img.className = 'inline h-5 w-5 align-text-bottom';
			img.setAttribute('data-nyax-emoji', id);
			img.setAttribute('draggable', 'false');
			return img;
		},
		shouldProcessNode(node) {
			const parent = node.parentElement;
			if (!parent) return false;
			const tagName = parent.tagName;
			if (this._ignoredSelectors.includes(tagName)) return false;
			if (parent.closest('[data-nyax-emoji]')) return false;
			return true;
		},
		processEmojiReplacements(root) {
			if (!this._emojiIds.size || !this._emojiRegex || !root) return;
			const walker = document.createTreeWalker(
				root,
				NodeFilter.SHOW_TEXT,
				{
					acceptNode: (node) => {
						if (!node.nodeValue || !node.nodeValue.includes('_'))
							return NodeFilter.FILTER_REJECT;
						if (!this.shouldProcessNode(node))
							return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_ACCEPT;
					},
				},
			);
			const textNodes = [];
			let current;
			while ((current = walker.nextNode())) {
				textNodes.push(current);
			}
			for (const textNode of textNodes) {
				const text = textNode.nodeValue;
				let match;
				let lastIndex = 0;
				const frag = document.createDocumentFragment();
				let replaced = false;
				this._emojiRegex.lastIndex = 0;
				while ((match = this._emojiRegex.exec(text))) {
					const token = match[0];
					const id = match[1];
					const start = match.index;
					if (lastIndex < start) {
						frag.appendChild(
							document.createTextNode(
								text.slice(lastIndex, start),
							),
						);
					}
					frag.appendChild(this.buildEmojiImage(id));
					replaced = true;
					lastIndex = start + token.length;
				}
				if (!replaced) continue;
				if (lastIndex < text.length) {
					frag.appendChild(
						document.createTextNode(text.slice(lastIndex)),
					);
				}
				textNode.replaceWith(frag);
			}
		},
	});

	/* ---------------------------------------------------------------------------
	 * direct-call: mirotalk.com のリンクをクリックしたとき直接通話に参加
	 * ------------------------------------------------------------------------- */

	Nyatten.registerModule({
		id: 'direct-call',
		name: '通話ダイレクト参加',
		description: 'MirotalkのURLをクリックしたとき、直接通話に参加します。',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('通話ダイレクト参加 モジュール初期化');

			this._clickHandler = (e) => {
				const config = ctx.getConfig();
				if (config.enabled === false) return;
				if (!localStorage.getItem('atten.acting_user_id')) return;

				const link = e.target.closest('a[href*="mirotalk.com"]');
				if (!link) return;

				const parsed = this._parseMirotalkUrl(link.href);
				if (!parsed) return;

				e.preventDefault();
				e.stopPropagation();

				const userInfo = this._getUserInfo();
				if (!userInfo) return;

				const params = new URLSearchParams({
					room: parsed.roomId,
					name: userInfo.name,
					avatar: userInfo.avatar,
					audio: '0',
					video: '0',
					chat: '1',
					notify: '0',
				});

				window.open(`https://${parsed.host}/join?${params}`, '_blank');
			};

			document.addEventListener('click', this._clickHandler, true);
		},
		onRouteChange(ctx) {},
		_parseMirotalkUrl(url) {
			try {
				const u = new URL(url);
				if (!u.hostname.endsWith('mirotalk.com')) return null;
				const room = u.searchParams.get('room');
				if (room) return { roomId: room, host: u.hostname };
				const parts = u.pathname
					.replace(/\/+$/, '')
					.split('/')
					.filter(Boolean);
				if (parts[0] === 'join' && parts[1])
					return { roomId: parts[1], host: u.hostname };
				if (parts.length === 1 && parts[0])
					return { roomId: parts[0], host: u.hostname };
			} catch (e) {}
			return null;
		},
		_getUserInfo() {
			const links = document.querySelectorAll('a[href^="/users/"]');
			for (const link of links) {
				if (
					link.closest(
						'[data-post-card-interactive], article, [role="article"]',
					)
				)
					continue;
				const img = link.querySelector('img');
				if (!img || !img.src) continue;
				const username = link
					.getAttribute('href')
					.replace('/users/', '')
					.split('/')[0]
					.split('?')[0];
				if (!username) continue;
				return {
					name: link.textContent.trim() || username,
					avatar: img.src,
				};
			}
			return null;
		},
	});

	/* ---------------------------------------------------------------------------
	 * direct-login: ログイン済みのScratchセッションを使って、Atten上のログイン
	 *   ダイアログにワンクリックログインのボタンを追加するモジュール。
	 *
	 *   注意（設計方針・重要）:
	 *   - ScratchのID/パスワードは一切扱わない。パスワード入力欄も作らない。
	 *   - Scratch側の「ログイン中かどうか・ユーザー名」は
	 *     GET https://scratch.mit.edu/session/ を叩いて確認するだけ
	 *     （既にブラウザ側でログイン済みのセッションを読むだけで、
	 *       ログイン処理自体は一切行わない）。
	 *   - Scratch連携に必要なCSRFトークン(scratchcsrftoken)は
	 *     content_script からは読めないため、background.js 経由で
	 *     chrome.cookies.get により該当Cookieの値だけを取得する。
	 *     scratchsessionsid には一切触れない。
	 *   - Attenの認証コード(/auth/codes)をScratchのプロフィールコメントへ
	 *     自動投稿するところまでは自動化するが、CAPTCHA(Turnstile)は
	 *     必ずユーザー自身に解いてもらう。ここは自動化しない。
	 *   - Scratchにログインしていない場合は、自動的に機能を無効表示にする。
	 * ------------------------------------------------------------------------- */

	const ATTEN_API_BASE = 'https://api.atten.win';
	const TURNSTILE_SITE_KEY = '0x4AAAAAACOJlGhSX4w8pOdK';

	Nyatten.registerModule({
		id: 'direct-login',
		name: 'ダイレクトログイン',
		description:
			'ログイン済みのScratchセッションを使って、ログイン画面からワンクリックでAttenにログインします。',
		icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('direct-login モジュール初期化');
			this._ctx = ctx;
			this._scratchSession = undefined; // undefined=未確認 null=未ログイン {username}=ログイン中
			this._dialogObserver = null;
			this._turnstileRequestId = null;
			this._turnstileToken = null;
			this._turnstileResultListener = null;

			this._watchLoginDialog();
		},
		onRouteChange(ctx) {
			this._ctx = ctx;
		},

		/* ------------------------------- Scratch側の状態確認 ------------------------------- */

		/**
		 * ログイン処理は一切行わず、既存のブラウザセッションから
		 * 「今scratch.mit.eduにログイン中かどうか」と「そのユーザー名」だけを読み取る。
		 * CORSプリフライトの制約を受けないよう、実際のfetchはbackground.js(service worker)側で行う。
		 */
		async _fetchScratchSession() {
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:get-scratch-session',
				});
				if (res && res.ok && res.username)
					return { username: res.username };
				return null;
			} catch (e) {
				Nyatten.warn(
					'[direct-login] Scratchセッション確認に失敗しました',
					e,
				);
				return null;
			}
		},

		/** キャッシュ済みならそれを返し、無ければ確認する */
		async _getScratchSession(forceRefresh = false) {
			if (!forceRefresh && this._scratchSession !== undefined) {
				return this._scratchSession;
			}
			const session = await this._fetchScratchSession();
			this._scratchSession = session;
			return session;
		},

		/* ------------------------------- ログインダイアログへの注入 ------------------------------- */

		_watchLoginDialog() {
			const tryInject = () => {
				const config = this._ctx?.getConfig?.() ?? {};
				if (config.enabled === false) return;

				const dialog = this._findAuthDialog();
				if (!dialog) return;
				if (dialog.querySelector('[data-nyatten-direct-login]')) return;

				this._injectDirectLoginButton(dialog);
			};

			this._dialogObserver = new MutationObserver(
				Nyatten.util.debounce(tryInject, 80),
			);
			this._dialogObserver.observe(
				document.body || document.documentElement,
				{
					childList: true,
					subtree: true,
				},
			);

			// 既に開いている場合に備えて一度実行
			tryInject();
		},

		/**
		 * 「ユーザー名を入力して認証方式(プロフィールコメント認証 等)を選ぶ」ダイアログを探す。
		 * Radixの自動生成ID(radix-_r_xx_)は再現性がないため使わず、
		 * 見出しのテキストと、Scratchユーザー名入力欄の有無で判定する。
		 */
		_findAuthDialog() {
			const dialogs = document.querySelectorAll('[role="dialog"]');
			for (const dialog of dialogs) {
				const heading = dialog.querySelector('h1, h2');
				const headingText = (heading?.textContent || '').trim();
				if (headingText !== 'ログイン' && headingText !== 'Log in')
					continue;

				const usernameInput =
					dialog.querySelector('input[type="text"]');
				if (!usernameInput) continue;

				return dialog;
			}
			return null;
		},

		_getUsernameInput(dialog) {
			return dialog.querySelector('input[type="text"]');
		},

		async _injectDirectLoginButton(dialog) {
			const wrap = document.createElement('div');
			wrap.setAttribute('data-nyatten-direct-login', '');
			wrap.className =
				'flex flex-col gap-2 mt-4 pt-4 border-t border-border';

			const session = await this._getScratchSession();

			if (!session) {
				// 未ログイン時は機能自体を出さない（自動的に無効化された状態）
				wrap.innerHTML =
					'<p class="text-xs text-muted-foreground text-center">' +
					'ダイレクトログイン' +
					'</p>';
				this._appendToDialog(dialog, wrap);
				return;
			}

			this._renderInitialButton(dialog, wrap, session.username);
			this._appendToDialog(dialog, wrap);
		},

		/**
		 * Atten側の「ログイン中の全アカウント一覧」(GET /session/users) に、
		 * このボタンが対象とするScratchユーザー名がすでに含まれていれば、
		 * ボタンをグレーアウトして押せないようにする。
		 * （同じScratchアカウントで多重ログインさせないための表示上のガード）
		 */
		async _applyAlreadyLoggedInState(wrap, username) {
			const loggedInNames = await this._fetchLoggedInScratchNames();
			// 取得中にダイアログが閉じられた/差し替えられた場合は何もしない
			if (!wrap.isConnected) return;
			// 既にログインフローが開始されている(ボタンが無い)場合も何もしない
			const button = wrap.querySelector(
				'[data-nyatten-direct-login-button]',
			);
			if (!button) return;

			const isAlreadyLoggedIn = loggedInNames.some(
				(name) => name.toLowerCase() === username.toLowerCase(),
			);
			if (!isAlreadyLoggedIn) return;

			button.disabled = true;
			button.textContent = `ログイン済みのアカウント(@${username})`;
			button.classList.add(
				'disabled:opacity-50',
				'disabled:cursor-not-allowed',
			);
		},

		/** 「Nyatten: <username> でダイレクトログイン」ボタン単体（初期表示）を描画する。
		 *  ログイン失敗時のリセットでも再利用する。
		 *  @param {string} [errorMessage] - 直前の失敗理由を示す文言。指定時はボタンの上に残す。 */
		_renderInitialButton(dialog, wrap, username, errorMessage) {
			wrap.innerHTML = '';

			if (errorMessage) {
				const errorEl = document.createElement('p');
				errorEl.setAttribute('data-nyatten-direct-login-error', '');
				errorEl.className = 'text-xs text-destructive text-center';
				errorEl.textContent = errorMessage;
				wrap.appendChild(errorEl);
			}

			// ユーザー名入力欄はAtten本体のReact state管理下にあり、外部からの書き込みは
			// 反映が不安定（3つの認証ボタンのdisabled状態と連動しない）ため触らない。
			// 代わりに、取得済みのusernameをNyattenのボタン自体に明記する。

			const button = document.createElement('button');
			button.type = 'button';
			button.setAttribute('data-nyatten-direct-login-button', '');
			button.className =
				'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border whitespace-nowrap transition-colors outline-none min-h-11 px-5 py-2 h-11 w-full text-base font-semibold border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
			button.textContent = `@${username} でダイレクトログイン`;
			button.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (button.disabled) return;
				this._startDirectLogin(dialog, wrap, username);
			});

			wrap.appendChild(button);

			// 描画直後に「既にログイン中のアカウント一覧」と突き合わせ、
			// 含まれていれば非同期でボタンをグレーアウトする
			// (一覧取得を待ってからボタンを出すとログイン操作全体が遅くなるため、後追いで反映する)
			this._applyAlreadyLoggedInState(wrap, username);
		},

		_appendToDialog(dialog, wrap) {
			// 「プロフィールコメント認証」等の認証方式ボタンが並ぶブロックの直後に差し込む
			const usernameInput = this._getUsernameInput(dialog);
			const authButtonsBlock =
				usernameInput?.closest('div')?.nextElementSibling;
			if (authButtonsBlock && authButtonsBlock.parentElement) {
				authButtonsBlock.parentElement.insertBefore(
					wrap,
					authButtonsBlock.nextSibling,
				);
			} else {
				dialog.appendChild(wrap);
			}
		},

		/* ------------------------------- ログインフロー本体 ------------------------------- */

		async _startDirectLogin(dialog, wrap, username) {
			wrap.innerHTML =
				'<p class="text-xs text-muted-foreground text-center">コードを生成…</p>';

			let codeRes;
			try {
				codeRes = await this._apiPost('/auth/codes', {
					username,
					type: 'profileComment',
					mode: 'login',
				});
			} catch (e) {
				wrap.innerHTML =
					'<p class="text-xs text-destructive text-center">コードの生成に失敗しました</p>';
				Nyatten.warn('[direct-login] /auth/codes 失敗', e);
				return;
			}

			const { code, token } = codeRes || {};
			if (!code || !token) {
				wrap.innerHTML =
					'<p class="text-xs text-destructive text-center">コードの取得に失敗しました</p>';
				return;
			}

			// Turnstileの表示はここで即座に開始し、ユーザーが認証している間に
			// プロフィールへのコメント投稿を裏で並行して進める。
			// (投稿完了を待ってからTurnstileを出すと、その分ログイン操作が遅くなるため)
			const postCommentPromise = this._postProfileComment(username, code);

			this._renderTurnstileStep(
				wrap,
				token,
				username,
				postCommentPromise,
				dialog,
			);
		},

		/**
		 * Turnstile(Cloudflareのスクリプト)は、このcontent script自身が動く
		 * isolated worldのCSP(拡張機能専用のCSPで、リモートホストのscript-srcは
		 * 許可されない)ではロードできない。一方でatten.win自体は自前のログイン/
		 * 登録フォームで同じスクリプトを直接読み込んで動かしており、
		 * atten.win側のCSPは元々challenges.cloudflare.comを許可している。
		 *
		 * isolated worldから注入した<script>要素はページのCSPではなく
		 * isolated world側のCSPに縛られてしまう(MAIN worldに注入した場合のみ
		 * ページのCSPが適用される)ため、Turnstileの読み込みと描画は
		 * turnstileBridge.js (world: "MAIN" で登録された別のcontent script)に
		 * 委譲し、document上のCustomEventで結果だけを受け取る。
		 */
		_requestTurnstileRender(hostSelector, action) {
			const requestId = `nyatten-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			this._turnstileRequestId = requestId;

			document.dispatchEvent(
				new CustomEvent('nyatten:mw:turnstile-render-request', {
					detail: {
						requestId,
						sitekey: TURNSTILE_SITE_KEY,
						hostSelector,
						action,
					},
				}),
			);

			return requestId;
		},

		_removeTurnstileWidget(requestId) {
			if (!requestId) return;
			document.dispatchEvent(
				new CustomEvent('nyatten:mw:turnstile-remove-request', {
					detail: { requestId },
				}),
			);
		},

		_renderTurnstileStep(
			wrap,
			token,
			username,
			postCommentPromise,
			dialog,
		) {
			wrap.innerHTML = '';

			const desc = document.createElement('p');
			desc.className = 'text-xs text-muted-foreground text-center';
			desc.textContent = 'コードをコメント…';
			wrap.appendChild(desc);

			// turnstileBridge.js(MAIN world)がこの要素をwidgetのホストとして描画する。
			// MAIN world側はセレクタでしかDOMを参照できない(JS変数を共有できない)ため、
			// 一意な属性値をつけてセレクタで指定する。
			const widgetHostId = `nyatten-turnstile-widget-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const widgetHost = document.createElement('div');
			widgetHost.setAttribute(
				'data-nyatten-turnstile-widget',
				widgetHostId,
			);
			wrap.appendChild(widgetHost);

			const submitBtn = document.createElement('button');
			submitBtn.type = 'button';
			submitBtn.disabled = true;
			submitBtn.className =
				'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border whitespace-nowrap transition-colors outline-none min-h-11 px-5 py-2 h-11 w-full text-base font-semibold border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
			submitBtn.textContent = 'ログイン中…';
			wrap.appendChild(submitBtn);

			this._turnstileToken = null;

			if (this._turnstileResultListener) {
				document.removeEventListener(
					'nyatten:mw:turnstile-result',
					this._turnstileResultListener,
				);
			}

			const requestId = this._requestTurnstileRender(
				`[data-nyatten-turnstile-widget="${widgetHostId}"]`,
				'login',
			);

			const cleanupTurnstile = () => {
				this._removeTurnstileWidget(requestId);
				if (this._turnstileResultListener) {
					document.removeEventListener(
						'nyatten:mw:turnstile-result',
						this._turnstileResultListener,
					);
					this._turnstileResultListener = null;
				}
			};

			// 失敗時共通の後処理: 投稿済みならコメントを削除し、UIを初期表示に戻す。
			// errorMessageを渡すと、リセット後もボタン上部にその文言を残す。
			const resetAfterFailure = async (errorMessage) => {
				cleanupTurnstile();
				try {
					const posted = await postCommentPromise;
					if (posted?.ok && posted.commentId) {
						await this._deleteProfileComment(
							username,
							posted.commentId,
						);
					}
				} catch (e) {
					Nyatten.warn(
						'[direct-login] 失敗後のコメント削除に失敗しました',
						e,
					);
				}
				this._renderInitialButton(dialog, wrap, username, errorMessage);
			};

			// コメント投稿とTurnstile認証、両方が揃った時点で自動的にログイン処理へ進む。
			// ボタンは操作対象ではなく状態表示専用（失敗してリセットされるまでは常に無効）。
			let commentPosting = true;
			let postedResult = null;
			let turnstileReady = false;
			let started = false;

			const maybeStartLogin = () => {
				if (started) return;
				if (commentPosting || !turnstileReady) return;
				started = true;
				runLogin();
			};

			const updateDescForTurnstileState = () => {
				if (commentPosting) return; // コメント投稿の進捗表示を上書きしない
				if (!turnstileReady) desc.textContent = 'キャプチャを待機...';
			};

			postCommentPromise.then((posted) => {
				commentPosting = false;
				postedResult = posted;
				if (!posted?.ok) {
					Nyatten.warn(
						'[direct-login] プロフィールへのコメント投稿に失敗しました',
					);
					resetAfterFailure(
						'コードのコメントに失敗しました。もう一度お試しください',
					);
					return;
				}
				updateDescForTurnstileState();
				maybeStartLogin();
			});

			this._turnstileResultListener = (event) => {
				const detail = event.detail || {};
				if (detail.requestId !== requestId) return;

				if (detail.type === 'token') {
					this._turnstileToken = detail.token;
					turnstileReady = true;
					maybeStartLogin();
				} else if (detail.type === 'error') {
					desc.textContent = 'キャプチャの読み込みに失敗しました';
				} else if (detail.type === 'expired') {
					this._turnstileToken = null;
					turnstileReady = false;
					desc.textContent =
						'キャプチャの有効期限が切れました。もう一度お試しください';
				}
			};
			document.addEventListener(
				'nyatten:mw:turnstile-result',
				this._turnstileResultListener,
			);

			const runLogin = async () => {
				try {
					desc.textContent = 'ログイン…';
					await this._apiPost('/auth/login', {
						cf_turnstile_response: this._turnstileToken,
						token,
					});
					cleanupTurnstile();

					// ログイン成功後、プロフィールに残った認証コードコメントを削除する。
					// 失敗してもログイン自体は既に完了しているのでUIをブロックしない。
					// (ボタン自体のテキストは変えず「ログイン中…」のまま、進捗はdesc側で示す)
					if (postedResult?.commentId) {
						desc.textContent = 'コードを削除…';
						await this._deleteProfileComment(
							username,
							postedResult.commentId,
						);
					}

					window.location.reload();
				} catch (err) {
					Nyatten.warn('[direct-login] /auth/login 失敗', err);
					await resetAfterFailure(this._describeLoginError(err));
				}
			};
		},

		/** /auth/login 失敗時のエラーコードを、ユーザー向けの文言に変換する */
		_describeLoginError(err) {
			const code = err?.body?.code;
			switch (code) {
				case 'scratch_auth_verify_failed':
					return 'コードの確認に失敗しました。もう一度お試しください。';
				case 'scratch_auth_invalid_code':
					return 'コードが無効です。もう一度お試しください。';
				default:
					return 'ログインに失敗しました。もう一度お試しください。';
			}
		},

		/* ------------------------------- Scratchプロフィールコメント投稿 ------------------------------- */

		/** 実際のfetchはbackground.js側で行う（CORSプリフライトの制約を受けないため） */
		async _postProfileComment(username, code) {
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:post-scratch-profile-comment',
					username,
					code,
				});
				if (!res || !res.ok) return { ok: false };
				return { ok: true, commentId: res.commentId ?? null };
			} catch (e) {
				Nyatten.warn(
					'[direct-login] プロフィールコメント投稿に失敗しました',
					e,
				);
				return { ok: false };
			}
		},

		/** ログイン成功後、投稿済みの認証コードコメントを削除する（失敗しても致命的ではないのでUIはブロックしない） */
		async _deleteProfileComment(username, commentId) {
			if (!commentId) return;
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:delete-scratch-profile-comment',
					username,
					commentId,
				});
				if (!res || !res.ok) {
					Nyatten.warn(
						'[direct-login] 認証コードコメントの削除に失敗しました',
						res,
					);
				}
			} catch (e) {
				Nyatten.warn(
					'[direct-login] 認証コードコメントの削除に失敗しました',
					e,
				);
			}
		},

		/* ------------------------------- Atten API ヘルパー ------------------------------- */

		/** document.cookie から csrftoken を読む（atten.win上のcontent_scriptなので直接読める） */
		_getAttenCsrfToken() {
			const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
			return match ? decodeURIComponent(match[1]) : null;
		},

		async _ensureAttenCsrfToken() {
			let token = this._getAttenCsrfToken();
			if (token) return token;
			// Cookieがまだ無ければ /csrf-token を叩いて発行してもらう
			try {
				await fetch(ATTEN_API_BASE + '/csrf-token', {
					credentials: 'include',
				});
			} catch (e) {
				Nyatten.warn(
					'[direct-login] /csrf-token の取得に失敗しました',
					e,
				);
			}
			return this._getAttenCsrfToken();
		},

		/**
		 * ログイン中の全アカウント一覧 (GET /session/users) を取得する。
		 * ダイアログ表示時の「既にログイン中のアカウントか」判定にのみ使う。
		 * 未ログイン(401)時はAtten本体同様に空配列として扱う。
		 */
		async _fetchLoggedInScratchNames() {
			try {
				const data = await this._apiGet('/session/users');
				if (!Array.isArray(data)) return [];
				return data
					.map((entry) => entry?.user?.scratch_name)
					.filter((name) => typeof name === 'string' && name);
			} catch (e) {
				Nyatten.warn(
					'[direct-login] /session/users の取得に失敗しました',
					e,
				);
				return [];
			}
		},

		/**
		 * Atten API への共通リクエストヘルパー。
		 * GET/POST とも「CSRFトークン付与 → fetch → JSON化 → エラー判定」の
		 * 流れが同一のため、ここに集約する（method/bodyだけが呼び出し側で異なる）。
		 */
		async _request(method, path, body, _isRetry = false) {
			const csrfToken = await this._ensureAttenCsrfToken();
			const headers = {
				Accept: 'application/json',
				'X-Client-Id': 'atten-web',
			};
			if (method !== 'GET') headers['Content-Type'] = 'application/json';
			if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

			const res = await fetch(ATTEN_API_BASE + path, {
				method,
				credentials: 'include',
				headers,
				body: method === 'GET' ? undefined : JSON.stringify(body),
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || json?.ok === false) {
				const code = json?.code;
				// csrf_validation_failed はCookie反映直後の一時的な失敗のことがあるため1回だけ再試行する
				if (
					method !== 'GET' &&
					code === 'csrf_validation_failed' &&
					!_isRetry
				) {
					return this._request(method, path, body, true);
				}
				const err = new Error(code || `HTTP ${res.status}`);
				err.body = json;
				throw err;
			}
			return json?.data ?? json;
		},

		_apiGet(path) {
			return this._request('GET', path);
		},

		_apiPost(path, body) {
			return this._request('POST', path, body);
		},
	});

	Nyatten.settingsGroups.push({
		moduleId: 'active-indicator',
		title: 'アクティブインジケータ',
		description: 'オンライン状態をユーザー名の先頭に埋め込み、他のユーザーの横にアクティブ状態を示す点を表示します。',
		fields: [
			{
				key: 'privateStatus',
				label: 'ステータスを非公開',
				type: 'toggle',
				description: '有効な場合、タイムスタンプの代わりに非公開を意味する文字を挿入します。',
			},
		],
	});

	Nyatten.settingsGroups.push({
		moduleId: 'ngcat',
		title: 'NGCat',
		description: 'NGワードを含む投稿を自動で非表示にします',
		fields: [
			{
				key: 'words',
				label: 'NGワード',
				type: 'textarea',
				description: '改行または,区切りで入力してください。',
				placeholder: '例: 犬, おにぎり, NyaX',
				rows: 4,
			},
		],
	});

	Nyatten.settingsGroups.push({
		moduleId: 'file-preview-plus',
		title: 'ファイルプレビュー+',
		description: 'ファイルプレビュー機能を強化',
		fields: [
			{
				key: 'image',
				label: 'Image',
				type: 'toggle',
				description: '画像ファイルのプレビューを有効にします',
			},
			{
				key: 'video',
				label: 'Video',
				type: 'toggle',
				description: '動画ファイルのプレビューを有効にします',
			},
			{
				key: 'audio',
				label: 'Audio',
				type: 'toggle',
				description: '音声ファイルのプレビューを有効にします',
			},
			{
				key: 'text',
				label: 'Text',
				type: 'toggle',
				description: 'テキストファイルのプレビューを有効にします',
			},
			{
				key: 'svg',
				label: 'SVG',
				type: 'toggle',
				description: 'SVGファイルのプレビューを有効にします',
			},
			{
				key: 'md',
				label: 'Markdown',
				type: 'toggle',
				description: 'Markdownファイルのプレビューを有効にします',
			},
			{
				key: 'html',
				label: 'HTML',
				type: 'toggle',
				description: 'HTMLファイルのプレビューを有効にします',
			},
			{
				key: 'js',
				label: 'JavaScript',
				type: 'toggle',
				description:
					'JavaScriptファイルのソースコードプレビューを有効にします',
			},
			{
				key: 'css',
				label: 'CSS',
				type: 'toggle',
				description:
					'CSSファイルのソースコードプレビューを有効にします',
			},
			{
				key: 'sb3',
				label: 'SB3',
				type: 'toggle',
				description:
					'Scratch 3.0プロジェクトファイルのプレビューを有効にします',
			},
			{
				key: 'json',
				label: 'JSON',
				type: 'toggle',
				description: 'JSONファイルのプレビューを有効にします',
			},
			{
				key: 'xml',
				label: 'XML',
				type: 'toggle',
				description: 'XMLファイルのプレビューを有効にします',
			},
		],
	});

	function cleanupNyattenPanel() {
		lastNyattenRenderedRoute = null;
		if (nyattenCardObserver) {
			nyattenCardObserver.disconnect();
			nyattenCardObserver = null;
		}

		const container = document.querySelector(
			'div.mx-auto.w-full.max-w-225',
		);
		if (!container) return;

		const panel = container.querySelector('[data-nyatten-settings-panel]');
		if (panel) panel.remove();

		const card = container.querySelector('[data-nyatten-settings-card]');
		if (card) card.remove();

		Array.from(container.children).forEach((el) => {
			if (el.style.display === 'none') {
				el.style.display = '';
			}
		});
	}

	function findSettingsCardContainer() {
		return document.querySelector('section.flex.flex-col.gap-3.px-4.py-6');
	}

	// injectNyattenCard は /settings ルート専用。非同期解決や
	// MutationObserver のコールバックが発火した時点で既にルートを
	// 離れている（例: /settings -> /settings/account）ケースがあるため、
	// 都度 isOnNyattenCardRoute() で現在のパス/ハッシュを確認する。
	function isOnNyattenCardRoute() {
		return location.pathname === '/settings' && !location.hash;
	}

	function injectNyattenCard(ctx) {
		Nyatten.util
			.waitForElement('section.flex.flex-col.gap-3.px-4.py-6')
			.then((container) => {
				if (!isOnNyattenCardRoute()) return;
				if (container.querySelector('[data-nyatten-settings-card]'))
					return;

				appendNyattenCard(container, ctx);

				// React の再描画でカードが消えたら再挿入する
				if (nyattenCardObserver) {
					nyattenCardObserver.disconnect();
				}
				nyattenCardObserver = new MutationObserver(
					Nyatten.util.debounce(() => {
						if (!isOnNyattenCardRoute()) {
							if (nyattenCardObserver) {
								nyattenCardObserver.disconnect();
								nyattenCardObserver = null;
							}
							return;
						}
						const current = findSettingsCardContainer();
						if (!current) return;
						if (
							!current.querySelector(
								'[data-nyatten-settings-card]',
							)
						) {
							appendNyattenCard(current, ctx);
						}
					}, 100),
				);
				nyattenCardObserver.observe(document.documentElement, {
					childList: true,
					subtree: true,
				});
			})
			.catch(() => {});
	}

	function appendNyattenCard(container, ctx) {
		if (container.querySelector('[data-nyatten-settings-card]')) return;
		const card = document.createElement('div');
		card.setAttribute('data-nyatten-settings-card', '');
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.className =
			'flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 transition-colors hover:bg-muted/40';
		card.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			pushRouteState('/settings#nyatten');
		});

		card.innerHTML =
			'<div class="flex-1 min-w-0">' +
			'<p class="text-sm font-medium text-foreground">Nyatten</p>' +
			'</div>' +
			'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0">' +
			'<path d="m9 18 6-6-6-6"/>' +
			'</svg>';

		container.appendChild(card);
	}

	function renderNyattenSettings(ctx) {
		const hash = location.hash;
		const currentRoute = `${location.pathname}${hash}`;

		if (lastNyattenRenderedRoute === currentRoute) {
			return;
		}
		lastNyattenRenderedRoute = currentRoute;

		Nyatten.util
			.waitForElement('div.mx-auto.w-full.max-w-225')
			.then((container) => {
				if (container.querySelector('[data-nyatten-settings-panel]'))
					return;

				Array.from(container.children).forEach((el) => {
					el.style.display = 'none';
				});

				const panel = document.createElement('div');
				panel.setAttribute('data-nyatten-settings-panel', '');
				panel.className = 'flex flex-col gap-4 px-4 py-6 md:px-6';

				if (hash === '#nyatten') {
					renderNyattenIndex(panel, ctx);
				} else if (hash.startsWith('#nyatten:')) {
					renderNyattenSubPage(
						panel,
						ctx,
						hash.slice('#nyatten:'.length),
					);
				}

				container.appendChild(panel);

				panel
					.querySelector('[data-nyatten-back-link]')
					.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						pushRouteState(
							panel.getAttribute('data-nyatten-back-to') ||
								'/settings',
						);
					});
			})
			.catch(() => {});
	}

	function renderUpdateNotification(latestVersion) {
		return (
			'<div class="nyatten-update-banner rounded-2xl border border-border bg-card p-4 flex flex-col gap-2" style="border-color: var(--primary, #3b82f6); background: linear-gradient(135deg, var(--card, #fff) 0%, rgba(59, 130, 246, 0.05) 100%);">' +
			'<div class="flex items-center gap-2">' +
			'<span class="flex h-2.5 w-2.5 rounded-full bg-primary animate-pulse" style="background-color: var(--primary, #3b82f6);"></span>' +
			'<h4 class="font-semibold text-sm text-foreground">新しいバージョンが利用可能です (v' +
			latestVersion.replace(/^v/, '') +
			')</h4>' +
			'</div>' +
			'<p class="text-xs text-muted-foreground">最新のリリースにアップデートして、新機能や修正を適用してください。</p>' +
			'<div class="flex gap-3 mt-1">' +
			'<a href="https://github.com/nyantorusabu/Nyatten/releases/latest" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow transition-all duration-200 hover:scale-105 active:scale-95" style="background-color: var(--primary, #3b82f6); color: var(--primary-foreground, #fff); text-decoration: none;">アップデートを確認</a>' +
			'</div>' +
			'</div>'
		);
	}

	function renderNyattenIndex(panel, ctx) {
		const query = (panel.getAttribute('data-nyatten-search') || '').trim();
		const cardsContainer = panel.querySelector('[data-nyatten-cards]');

		if (!cardsContainer) {
			const updateCheckMod = getModuleById('update-check');
			const updateBanner =
				updateCheckMod &&
				updateCheckMod.hasUpdate &&
				updateCheckMod.latestVersion
					? renderUpdateNotification(updateCheckMod.latestVersion)
					: '';

			panel.innerHTML =
				renderPanelHeader('Nyatten') +
				renderSearchBox(query) +
				'<div class="rounded-2xl border border-border bg-card p-4">' +
				`<p class="text-sm text-muted-foreground">Nyattenは非公式のサードパーティツールです。Nyattenの問題をAttenTeamに報告しないでください。</p>` +
				'</div>' +
				updateBanner +
				'<div data-nyatten-cards class="flex flex-col gap-3"></div>';

			panel.setAttribute('data-nyatten-back-to', '/settings');

			wireSearchBox(panel, () => renderNyattenIndex(panel, ctx));
		}

		const container = panel.querySelector('[data-nyatten-cards]');
		container.innerHTML =
			renderModuleCards(ctx, query) + renderGroupCards(ctx);
	}

	const CHEVRON_RIGHT_SVG =
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0">' +
		'<path d="m9 18 6-6-6-6"/>' +
		'</svg>';

	/**
	 * Nyatten設定一覧のカード行(モジュールカード/グループカード共通の見た目)を描画する。
	 * 両者はアイコン・タイトル・説明・遷移用data属性しか違わないため、共通シェルをここに集約する。
	 * @param {{dataAttr: string, dataValue: string, iconHtml: string, title: string, description?: string, extraHtml?: string}} opts
	 */
	function renderNavCardRow(opts) {
		const { dataAttr, dataValue, iconHtml, title, description, extraHtml } =
			opts;
		return (
			'<div role="button" tabindex="0" ' +
			dataAttr +
			'="' +
			dataValue +
			'" class="flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 transition-colors hover:bg-muted/40">' +
			(iconHtml ? '<div class="shrink-0">' + iconHtml + '</div>' : '') +
			'<div class="flex-1 min-w-0">' +
			'<p class="text-sm font-medium text-foreground">' +
			title +
			'</p>' +
			(description
				? '<p class="text-xs text-muted-foreground truncate">' +
					description +
					'</p>'
				: '') +
			'</div>' +
			(extraHtml || '') +
			CHEVRON_RIGHT_SVG +
			'</div>'
		);
	}

	function renderModuleCards(ctx, query) {
		const nyatten = ctx.nyatten;
		const modules = filterAndSortModules(nyatten._modules || [], query);

		return modules
			.map((mod) => {
				const enabled = nyatten.config[mod.id]?.enabled;
				const isEnabled = enabled !== false;
				const statusBadge =
					'<span class="text-xs ' +
					(isEnabled ? 'text-primary' : 'text-muted-foreground') +
					'">' +
					(isEnabled ? '有効' : '無効') +
					'</span>';
				return renderNavCardRow({
					dataAttr: 'data-nyatten-module',
					dataValue: mod.id,
					iconHtml: renderIcon(mod.icon || mod.id),
					title: escHtml(mod.name || mod.id),
					description: mod.description
						? escHtml(mod.description)
						: '',
					extraHtml: statusBadge,
				});
			})
			.join('');
	}

	function renderGroupCards(ctx) {
		const nyatten = ctx.nyatten;
		const modules = nyatten._modules || [];
		const moduleIds = new Set(modules.map((m) => m.id));
		const groups = (nyatten.settingsGroups || []).filter(
			(g) => !moduleIds.has(g.moduleId),
		);

		return groups
			.map((group) => {
				let groupIcon = group.icon;
				if (!groupIcon) {
					const mod = getModuleById(group.moduleId);
					groupIcon = mod?.icon ?? group.moduleId;
				}
				return renderNavCardRow({
					dataAttr: 'data-nyatten-group',
					dataValue: group.moduleId,
					iconHtml: renderIcon(groupIcon),
					title: group.title,
					description: group.description,
				});
			})
			.join('');
	}

	function renderNyattenSubPage(panel, ctx, groupId) {
		const nyatten = ctx.nyatten;

		if (groupId.startsWith('module:')) {
			renderModuleTab(panel, ctx, groupId.slice('module:'.length));
			return;
		}

		const group = (nyatten.settingsGroups || []).find(
			(g) => g.moduleId === groupId,
		);
		if (!group) {
			renderNyattenIndex(panel, ctx);
			return;
		}

		panel.innerHTML =
			renderPanelHeader(group.title) +
			'<div class="rounded-2xl border border-border bg-card p-4">' +
			'<p class="text-sm text-muted-foreground mb-3">' +
			group.description +
			'</p>' +
			'<div class="flex flex-col gap-3">' +
			group.fields
				.map(function (field) {
					return renderField(field, group.moduleId, ctx);
				})
				.join('') +
			'</div>' +
			'</div>';

		panel.setAttribute('data-nyatten-back-to', '/settings#nyatten');
	}

	function renderModuleTab(panel, ctx, moduleId) {
		const nyatten = ctx.nyatten;
		const module = getModuleById(moduleId);
		if (!module) {
			renderNyattenIndex(panel, ctx);
			return;
		}

		const enabled = nyatten.config[module.id]?.enabled;
		const isEnabled = enabled !== false;
		const moduleGroup = (nyatten.settingsGroups || []).find(
			(g) => g.moduleId === module.id,
		);
		const query = (panel.getAttribute('data-nyatten-search') || '').trim();
		const q = query.toLowerCase();

		const fieldFilter = (f) => {
			if (!query) return true;
			const label = (f.label || '').toLowerCase();
			const desc = (f.description || '').toLowerCase();
			const key = (f.key || '').toLowerCase();
			return label.includes(q) || desc.includes(q) || key.includes(q);
		};

		const toggleHtml = module.locked
			? '<div class="flex items-center justify-between gap-4">' +
				'<div class="text-sm text-muted-foreground">常に有効</div>' +
				renderToggleSwitch(null, null, true, { disabled: true }) +
				'</div>'
			: '<div class="flex items-center justify-between gap-4">' +
				'<div class="text-sm text-foreground">モジュールを有効化</div>' +
				renderToggleSwitch(
					'data-nyatten-module-enabled',
					module.id,
					isEnabled,
					{
						ariaLabel:
							(module.name || module.id) +
							(isEnabled ? ' を無効化' : ' を有効化'),
					},
				) +
				'</div>';

		const fieldsContainer = panel.querySelector('[data-nyatten-fields]');

		if (!fieldsContainer) {
			panel.innerHTML =
				renderPanelHeader(module.name || module.id) +
				renderSearchBox(query) +
				'<div class="rounded-2xl border border-border bg-card p-4 mb-4">' +
				'<div class="flex flex-col gap-4">' +
				'<div class="flex items-center justify-between gap-4">' +
				'<div class="flex-1 min-w-0">' +
				'<p class="text-sm font-medium text-foreground">' +
				escHtml(module.name || module.id) +
				'</p>' +
				(module.description
					? '<p class="text-xs text-muted-foreground mt-0.5">' +
						escHtml(module.description) +
						'</p>'
					: '') +
				'</div>' +
				'</div>' +
				toggleHtml +
				'</div>' +
				'</div>';

			panel.setAttribute('data-nyatten-back-to', '/settings#nyatten');

			wireSearchBox(panel, () => renderModuleTab(panel, ctx, moduleId));
		}

		const oldFields = panel.querySelector('[data-nyatten-fields]');
		if (oldFields) oldFields.remove();

		if (moduleGroup && moduleGroup.fields && moduleGroup.fields.length) {
			const fields = moduleGroup.fields.filter(fieldFilter);
			if (fields.length) {
				const el = document.createElement('div');
				el.setAttribute('data-nyatten-fields', '');
				el.innerHTML =
					'<div class="rounded-2xl border border-border bg-card p-4">' +
					'<div class="flex flex-col gap-3">' +
					fields
						.map(function (f) {
							return renderField(f, module.id, ctx);
						})
						.join('') +
					'</div>' +
					'</div>';
				panel.appendChild(el);
			} else if (query) {
				const el = document.createElement('div');
				el.setAttribute('data-nyatten-fields', '');
				el.innerHTML =
					'<div class="rounded-2xl border border-border bg-card p-4">' +
					'<p class="text-sm text-muted-foreground">該当する設定項目がありません</p>' +
					'</div>';
				panel.appendChild(el);
			}
		}
	}

	// HTMLエスケープ
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
	function escAttr(s) {
		return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	const FIELD_INPUT_CLASS =
		'rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors';

	/** data-nyatten-field 属性値 ("<moduleId>.<key>") を組み立てる */
	function fieldName(moduleId, key) {
		return moduleId + '.' + key;
	}

	/**
	 * text/textarea/number/select 共通の「ラベル + 説明文 + 入力欄」ラッパーを描画する。
	 * @param {Object} field - フィールド定義 (label, description を使用)
	 * @param {string} inputHtml - 中身の入力要素HTML
	 */
	function fieldWrapper(field, inputHtml) {
		return (
			'<div class="flex flex-col gap-1.5">' +
			'<label class="text-sm font-medium text-foreground">' +
			escHtml(field.label) +
			'</label>' +
			(field.description
				? '<p class="text-xs text-muted-foreground">' +
					escHtml(field.description) +
					'</p>'
				: '') +
			inputHtml +
			'</div>'
		);
	}

	/**
	 * toggleスイッチ(role="switch")のHTMLを描画する。設定フィールド・モジュール有効化・
	 * 常時有効(locked)表示のいずれからも使う共通部品。
	 * @param {string} dataAttr - 付与するdata-*属性名 (例: 'data-nyatten-field')
	 * @param {string} dataValue - その属性値
	 * @param {boolean} checked
	 * @param {{ariaLabel?: string, disabled?: boolean}} [opts]
	 */
	function renderToggleSwitch(dataAttr, dataValue, checked, opts = {}) {
		const { ariaLabel, disabled } = opts;
		return (
			'<button type="button" role="switch" ' +
			(dataAttr ? dataAttr + '="' + escAttr(dataValue) + '"' : '') +
			(ariaLabel ? ' aria-label="' + escAttr(ariaLabel) + '"' : '') +
			(disabled ? ' aria-disabled="true"' : '') +
			' class="relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ' +
			(disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer') +
			' ' +
			(checked ? 'bg-primary' : 'bg-border') +
			'"' +
			' style="width:44px;height:24px"' +
			' data-state="' +
			(checked ? 'checked' : 'unchecked') +
			'">' +
			'<span data-slot="switch-thumb" class="pointer-events-none inline-block rounded-full bg-background shadow-sm border-2 border-border transition-transform duration-200"' +
			' style="width:20px;height:20px;transform:translateX(' +
			(checked ? '22px' : '2px') +
			')">' +
			'</span>' +
			'</button>'
		);
	}

	/**
	 * JSONスキーマ定義から設定フィールドのHTMLを生成する。
	 *
	 * @param {Object} field - フィールド定義
	 * @param {string} field.key - 設定キー
	 * @param {string} field.label - 表示ラベル
	 * @param {string} field.type - フィールド種別 (toggle | text | textarea | number | select)
	 * @param {string} [field.description] - 説明文
	 * @param {Array} [field.options] - select型の場合の選択肢 [{label, value}]
	 * @param {string} [field.placeholder] - text/number/textarea型の場合のプレースホルダー
	 * @param {string} [field.unit] - number型の場合の単位
	 */
	function renderSchemaField(field, moduleId, ctx) {
		const nyatten = ctx.nyatten;
		const value = nyatten.config[moduleId]?.[field.key];
		const name = fieldName(moduleId, field.key);

		switch (field.type) {
			case 'toggle':
				return (
					'<div class="flex items-center justify-between gap-4">' +
					'<div class="flex-1 min-w-0">' +
					'<p class="text-sm font-medium text-foreground">' +
					escHtml(field.label) +
					'</p>' +
					(field.description
						? '<p class="text-xs text-muted-foreground mt-0.5">' +
							escHtml(field.description) +
							'</p>'
						: '') +
					'</div>' +
					renderToggleSwitch('data-nyatten-field', name, !!value) +
					'</div>'
				);

			case 'text':
				return fieldWrapper(
					field,
					'<input type="text" data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' value="' +
						escAttr(String(value ?? '')) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="' +
						FIELD_INPUT_CLASS +
						'" />',
				);

			case 'textarea':
				return fieldWrapper(
					field,
					'<textarea data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' rows="' +
						escAttr(String(field.rows || 4)) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="min-h-[88px] ' +
						FIELD_INPUT_CLASS +
						'">' +
						escHtml(String(value ?? '')) +
						'</textarea>',
				);

			case 'number':
				return fieldWrapper(
					field,
					'<div class="flex items-center gap-2">' +
						'<input type="number" data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' value="' +
						escAttr(String(value ?? '')) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="flex-1 ' +
						FIELD_INPUT_CLASS +
						'" />' +
						(field.unit
							? '<span class="text-sm text-muted-foreground">' +
								escHtml(field.unit) +
								'</span>'
							: '') +
						'</div>',
				);

			case 'select': {
				const optsHtml = (field.options || [])
					.map((opt) => {
						const sel =
							String(value) === String(opt.value)
								? ' selected'
								: '';
						return (
							'<option value="' +
							escAttr(String(opt.value)) +
							'"' +
							sel +
							'>' +
							escHtml(opt.label) +
							'</option>'
						);
					})
					.join('');
				return fieldWrapper(
					field,
					'<select data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' class="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors">' +
						optsHtml +
						'</select>',
				);
			}

			default:
				return '';
		}
	}

	function renderField(field, moduleId, ctx) {
		return renderSchemaField(field, moduleId, ctx);
	}

	function renderIcon(icon) {
		if (!icon) return '';

		// インラインアイコンデータ { type, url?, svg? }
		if (typeof icon === 'object') {
			if (icon.type === 'url' && icon.url) {
				return (
					'<img src="' +
					icon.url +
					'" alt="" class="w-5 h-5 shrink-0 rounded" />'
				);
			}
			if (icon.svg) return icon.svg;
			return '';
		}

		// 文字列 → Nyatten.icons から検索
		const iconDef = Nyatten.icons[icon];
		if (!iconDef) return '';
		if (iconDef.type === 'url' && iconDef.url) {
			return (
				'<img src="' +
				iconDef.url +
				'" alt="" class="w-5 h-5 shrink-0 rounded" />'
			);
		}
		if (iconDef.svg) return iconDef.svg;
		return '';
	}

	// イベント委譲: トグルスイッチ・グループカードの変更を監視
	document.addEventListener('click', async (e) => {
		// フィールドトグル（設定項目のON/OFF）
		const fieldBtn = e.target.closest(
			'[role="switch"][data-nyatten-field]',
		);
		if (fieldBtn) {
			e.preventDefault();
			e.stopPropagation();

			const fieldPath = fieldBtn.getAttribute('data-nyatten-field');
			const parts = fieldPath.split('.');
			if (parts.length !== 2) return;
			const moduleId = parts[0];
			const key = parts[1];

			const module = getModuleById(moduleId);
			if (!module) return;

			const modCtx = window.Nyatten._makeContext(module);
			const current = modCtx.getConfig();
			const newValue = !current[key];
			await modCtx.setConfig({ [key]: newValue });

			updateToggleUI(fieldBtn, newValue);
			return;
		}

		// モジュール有効化トグル
		const moduleToggleBtn = e.target.closest(
			'[role="switch"][data-nyatten-module-enabled]',
		);
		if (moduleToggleBtn) {
			e.preventDefault();
			e.stopPropagation();

			const moduleId = moduleToggleBtn.getAttribute(
				'data-nyatten-module-enabled',
			);
			const module = getModuleById(moduleId);
			if (!module || module.locked) return;

			const modCtx = window.Nyatten._makeContext(module);
			const current = modCtx.getConfig();
			const newValue = !(current.enabled !== false); // undefined → true
			await modCtx.setConfig({ enabled: newValue });

			updateToggleUI(moduleToggleBtn, newValue);
			return;
		}

		// モジュールカードのクリック → モジュールタブ遷移
		const moduleCard = e.target.closest('[data-nyatten-module]');
		if (moduleCard) {
			e.preventDefault();
			const moduleId = moduleCard.getAttribute('data-nyatten-module');
			pushRouteState('/settings#nyatten:module:' + moduleId);
			return;
		}

		// グループカードのクリック → サブページ遷移
		const groupCard = e.target.closest('[data-nyatten-group]');
		if (groupCard) {
			e.preventDefault();
			const gid = groupCard.getAttribute('data-nyatten-group');
			pushRouteState('/settings#nyatten:' + gid);
		}
	});

	function updateToggleUI(btn, isChecked) {
		btn.setAttribute('data-state', isChecked ? 'checked' : 'unchecked');
		btn.className = [
			'relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200',
			isChecked ? 'bg-primary' : 'bg-border',
		].join(' ');
		const thumb = btn.querySelector('[data-slot="switch-thumb"]');
		if (thumb) {
			thumb.style.transform =
				'translateX(' + (isChecked ? '22px' : '2px') + ')';
			thumb.className = [
				'pointer-events-none inline-block rounded-full bg-background shadow-sm border-2 border-border transition-transform duration-200',
			].join(' ');
		}
	}

	// change イベント委譲: テキスト・数値・セレクトの変更を保存
	document.addEventListener('change', async (e) => {
		const el = e.target.closest('[data-nyatten-field]');
		if (!el) return;
		const tag = el.tagName;
		// switch (role="switch") は click で処理するので change では無視
		if (tag === 'BUTTON' && el.getAttribute('role') === 'switch') return;

		const fieldPath = el.getAttribute('data-nyatten-field');
		const parts = fieldPath.split('.');
		if (parts.length !== 2) return;
		const moduleId = parts[0];
		const key = parts[1];

		const module = getModuleById(moduleId);
		if (!module) return;

		let newValue;
		if (tag === 'SELECT') {
			newValue = el.value;
		} else if (tag === 'INPUT' || tag === 'TEXTAREA') {
			const type = el.getAttribute('type');
			if (tag === 'INPUT' && type === 'number') {
				newValue = el.value === '' ? '' : Number(el.value);
			} else {
				newValue = el.value;
			}
		} else {
			return;
		}

		const modCtx = window.Nyatten._makeContext(module);
		await modCtx.setConfig({ [key]: newValue });
	});

	/* ===========================================================================
	 * 4. 起動
	 * ========================================================================= */
	Nyatten.registerModule({
		id: 'update-check',
		name: '更新確認',
		description:
			'Nyattenの新しいバージョンがリリースされているかを確認します',
		defaultConfig: {
			enabled: true,
		},
		latestVersion: null,
		hasUpdate: false,
		async init(ctx) {
			ctx.log('更新確認 モジュール初期化');
			const config = ctx.getConfig();
			if (!config.enabled) return;

			try {
				const current =
					chrome.runtime?.getManifest()?.version || '0.0.0';
				ctx.log('現在のバージョン:', current);

				const response = await fetch(
					'https://api.github.com/repos/nyantorusabu/Nyatten/releases/latest',
				);
				if (!response.ok) {
					throw new Error('HTTP error! status: ' + response.status);
				}
				const data = await response.json();
				const latest = data.tag_name;
				if (!latest) {
					throw new Error('tag_name is missing in release response');
				}

				ctx.log('最新のバージョン (GitHub):', latest);

				// バージョン比較
				const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
				const currentParts = parse(current);
				const latestParts = parse(latest);

				if (currentParts.some(isNaN) || latestParts.some(isNaN)) {
					throw new Error(
						'Invalid version format: ' + current + ' vs ' + latest,
					);
				}

				const [cMajor, cMinor, cPatch] = currentParts;
				const [lMajor, lMinor, lPatch] = latestParts;

				let isNew = false;
				if (lMajor > cMajor) {
					isNew = true;
				} else if (lMajor === cMajor) {
					if (lMinor > cMinor) {
						isNew = true;
					} else if (lMinor === cMinor) {
						if (lPatch > cPatch) {
							isNew = true;
						}
					}
				}

				if (isNew) {
					ctx.log('新しいバージョンが検出されました:', latest);
					this.latestVersion = latest;
					this.hasUpdate = true;
				}
			} catch (e) {
				ctx.nyatten.warn('更新確認に失敗しました:', e);
			}
		},
	});

	Nyatten.registerModule({
		id: 'turbowarp-player-plus',
		name: 'TurboWarpプレイヤー+',
		description: 'ユーザー名を適応し自動でプロジェクトを実行する',
		defaultConfig: {
			enabled: true,
		},
		init(ctx) {
			ctx.log('TurboWarpプレイヤー モジュール初期化');
			this._ctx = ctx;
			this._username = null;

			// Fetch username in the background
			this._fetchUsername();

			// MutationObserver to watch for newly added iframes
			this._observer = new MutationObserver((mutations) => {
				let hasIframe = false;
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (node instanceof Element) {
							if (
								node.tagName === 'IFRAME' ||
								node.querySelector('iframe')
							) {
								hasIframe = true;
								break;
							}
						}
					}
					if (hasIframe) break;
				}
				if (hasIframe) {
					this._replaceScratchPlayers();
				}
			});
			this._observer.observe(document.body, {
				childList: true,
				subtree: true,
			});

			// Run replacement for existing iframes
			this._replaceScratchPlayers();
		},
		onRouteChange(ctx) {
			this._ctx = ctx;
			this._replaceScratchPlayers();
		},
		async _fetchUsername() {
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:get-scratch-session',
				});
				if (res && res.ok && res.username) {
					this._username = res.username;
					// Re-run replacement to inject username parameter
					this._replaceScratchPlayers();
				}
			} catch (e) {
				Nyatten.warn(
					'[turbowarp-player] Failed to fetch Scratch username',
					e,
				);
			}
		},
		_replaceScratchPlayers() {
			const config = this._ctx?.getConfig() ?? {};
			if (config.enabled === false) return;

			const iframes = document.querySelectorAll(
				'iframe[src*="scratch.mit.edu/projects/"], iframe[src*="turbowarp.org"]',
			);
			const currentUsernameKey = this._username || '';
			for (const iframe of iframes) {
				if (
					iframe.getAttribute('data-nyatten-turbowarp-processed') ===
					currentUsernameKey
				) {
					continue;
				}
				const src = iframe.src;
				const match =
					src.match(
						/scratch\.mit\.edu\/projects\/(?:embed\/)?(\d+)/,
					) ||
					src.match(/scratch\.mit\.edu\/projects\/(\d+)/) ||
					src.match(/turbowarp\.org\/(?:projects\/)?(\d+)/);
				if (match) {
					const projectId = match[1];
					const params = new URLSearchParams({
						autoplay: 'true',
					});
					if (this._username) {
						params.set('username', this._username);
					}
					const expectedSrc = `https://turbowarp.org/projects/${projectId}/embed?${params.toString().replace('autoplay=true', 'autoplay')}`;
					if (iframe.src !== expectedSrc) {
						iframe.src = expectedSrc;
					}
					iframe.removeAttribute('width');
					iframe.removeAttribute('height');
					iframe.setAttribute(
						'data-nyatten-turbowarp-processed',
						currentUsernameKey,
					);
				}
			}
		},
	});

	Nyatten.init();
})();
