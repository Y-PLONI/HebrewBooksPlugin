/* הרמת התוסף בדפדפן ללא אוצריא, לבדיקות תצוגה בלבד.
   מדמה את ה-SDK (window.Otzaria) עם ערכות הצבעים והטיפוגרפיה האמיתיות של
   אוצריא (ברירות המחדל: seed חום־זהבהב בבהיר, סגול בכהה, גופן ספר 25px). */
(function () {
  var params = new URLSearchParams(location.search);
  var isDark = params.get('mode') === 'dark';

  var schemes = {
    light: {"primary":"#805610","onPrimary":"#ffffff","primaryContainer":"#ffddb3","onPrimaryContainer":"#633f00","secondary":"#6f5b40","onSecondary":"#ffffff","secondaryContainer":"#fbdebc","onSecondaryContainer":"#56442a","tertiary":"#51643f","onTertiary":"#ffffff","tertiaryContainer":"#d4eabb","onTertiaryContainer":"#3a4c2a","surface":"#fff8f4","onSurface":"#201b13","onSurfaceVariant":"#4f4539","surfaceContainerLowest":"#ffffff","surfaceContainerLow":"#fff1e5","surfaceContainer":"#f9ecdf","surfaceContainerHigh":"#f3e6da","surfaceContainerHighest":"#ede0d4","error":"#ba1a1a","onError":"#ffffff","errorContainer":"#ffdad6","onErrorContainer":"#93000a","outline":"#817567","outlineVariant":"#d3c4b4","inverseSurface":"#362f27","onInverseSurface":"#fcefe2","inversePrimary":"#f4bd6f","shadow":"#000000","scrim":"#000000","surfaceTint":"#805610"},
    dark: {"primary":"#ebb5ed","onPrimary":"#49204e","primaryContainer":"#613766","onPrimaryContainer":"#ffd6fe","secondary":"#d7bfd5","onSecondary":"#3b2b3c","secondaryContainer":"#534153","onSecondaryContainer":"#f4dbf1","tertiary":"#f6b8ad","onTertiary":"#4c251f","tertiaryContainer":"#673b34","onTertiaryContainer":"#ffdad4","surface":"#171216","onSurface":"#ebdfe6","onSurfaceVariant":"#d0c3cc","surfaceContainerLowest":"#110d11","surfaceContainerLow":"#1f1a1f","surfaceContainer":"#231e23","surfaceContainerHigh":"#2e282d","surfaceContainerHighest":"#393338","error":"#ffb4ab","onError":"#690005","errorContainer":"#93000a","onErrorContainer":"#ffdad6","outline":"#998d96","outlineVariant":"#4d444c","inverseSurface":"#ebdfe6","onInverseSurface":"#352f34","inversePrimary":"#7b4e7f","shadow":"#000000","scrim":"#000000","surfaceTint":"#ebb5ed"}
  };

  // אוצריא מזריקה @font-face לגופן הספר שנבחר עוד לפני plugin.boot.
  var style = document.createElement('style');
  style.textContent =
    "@font-face{font-family:'FrankRuhlCLM';src:url('/__preview/book-font.ttf') format('truetype');font-display:block;}";
  (document.head || document.documentElement).appendChild(style);

  // יומן גלוי ב-DOM — מאפשר לקרוא שגיאות גם בצילום מסך של דפדפן headless.
  var log = document.createElement('pre');
  log.id = 'preview-log';
  log.style.display = 'none';
  var record = function (kind) {
    return function () {
      log.textContent += kind + ': ' + Array.prototype.join.call(arguments, ' ') + '\n';
    };
  };
  console.error = record('error');
  console.warn = record('warn');
  window.addEventListener('error', function (event) {
    log.textContent += 'uncaught: ' + event.message + '\n';
  });
  window.addEventListener('unhandledrejection', function (event) {
    log.textContent += 'rejected: ' + (event.reason && event.reason.message ? event.reason.message : event.reason) + '\n';
  });
  window.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(log);
  });

  var listeners = {};
  window.Otzaria = {
    call: function (method, payload) {
      payload = payload || {};
      if (method === 'network.fetchStream') {
        return (async function* () {
          var url = new URL(payload.url);
          var response = await fetch(url.pathname, {
            method: payload.method || 'GET',
            headers: payload.headers,
            body: payload.body,
          });
          var responseHeaders = {};
          response.headers.forEach(function (value, key) {
            responseHeaders[key] = value;
          });
          yield {
            sequence: 0,
            type: 'response',
            status: response.status,
            ok: response.ok,
            headers: responseHeaders,
          };
          if (!response.body) return;
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var sequence = 1;
          try {
            while (true) {
              var part = await reader.read();
              if (part.done) break;
              var text = decoder.decode(part.value, { stream: true });
              if (text) yield { sequence: sequence++, type: 'data', body: text };
            }
            var tail = decoder.decode();
            if (tail) yield { sequence: sequence++, type: 'data', body: tail };
          } finally {
            await reader.cancel();
          }
        })();
      }
      if (method === 'network.fetch') {
        var url = new URL(payload.url);
        return fetch(url.pathname, {
          method: payload.method || 'GET',
          headers: payload.headers,
          body: payload.body,
        }).then(function (response) {
          return response.text().then(function (body) {
            return { success: true, error: null, data: { status: response.status, ok: response.ok, body: body } };
          });
        });
      }
      if (method === 'ui.showError' || method === 'ui.showMessage') {
        console.log('[' + method + ']', payload.message);
        return Promise.resolve({ success: true, error: null, data: true });
      }
      if (method === 'library.findBooks') {
        return Promise.resolve({ success: true, error: null, data: [] });
      }
      if (method === 'search.query') {
        var nativeResults = [
          { id: 1, type: 'text', source: 'library', bookId: 'משנה ברורה', book: 'משנה ברורה', categoryPath: '/הלכה/אורח חיים', reference: 'סימן רמב', text: 'דיני השבת ומלאכותיה נלמדים מן הפסוקים ומדברי חכמים', index: 42, mergedCount: 1 },
          { id: 5, type: 'text', source: 'library', bookId: 'משנה ברורה', book: 'משנה ברורה', categoryPath: '/הלכה/אורח חיים', reference: 'סימן שח', text: 'מוקצה בשבת ואיסור טלטול כלי שמלאכתו לאיסור', index: 51, mergedCount: 1 },
          { id: 6, type: 'text', source: 'library', bookId: 'שולחן ערוך', book: 'שולחן ערוך', categoryPath: '/הלכה/אורח חיים', reference: 'סימן רסב', text: 'יסדר שולחנו מבעוד יום לכבוד השבת', index: 18, mergedCount: 1 },
          { id: 7, type: 'text', source: 'library', bookId: 'רמב״ם', book: 'משנה תורה', categoryPath: '/הלכה/ראשונים', reference: 'הלכות שבת פרק א', text: 'שביתה בשביעי ממלאכה מצות עשה', index: 3, mergedCount: 1 },
          { id: 2, type: 'text', source: 'library', bookId: 'מסילת ישרים', book: 'מסילת ישרים', categoryPath: '/מחשבה/מוסר', reference: 'פרק א', text: 'יסוד החסידות ושורש העבודה התמימה הוא שיתברר ויתאמת אצל האדם', index: 7, mergedCount: 1 },
          { id: 3, type: 'text', source: 'library', bookId: 'רש״י', book: 'רש״י על התורה', categoryPath: '/תנ״ך/מפרשים', reference: 'שמות כ ח', text: 'זכור את יום השבת לקדשו', index: 90, mergedCount: 1 },
          { id: 4, type: 'pdf', source: 'library', bookId: 'ספר הזוהר', book: 'ספר הזוהר', categoryPath: '/קבלה', reference: 'עמוד יב', text: 'רזא דשבת איהי שבת', index: 12, mergedCount: 1 },
        ];
        var nativeOffset = Number(payload.offset || 0);
        var nativeLimit = Number(payload.limit || 100);
        var nativePage = nativeResults.slice(nativeOffset, nativeOffset + nativeLimit);
        // search.query הוא ערוץ מזרים: ה-Host מחזיר AsyncIterable של chunks.
        var chunk = {
          sequence: 0,
          results: nativePage,
          total: nativeResults.length,
          groupCount: null,
          truncated: nativeOffset + nativePage.length < nativeResults.length,
          limit: nativeLimit,
          offset: nativeOffset,
          facets: ['/'],
        };
        var chunks = [chunk];
        var stream = {};
        stream[Symbol.asyncIterator] = function () {
          var index = 0;
          return {
            next: function () {
              var done = index >= chunks.length;
              return Promise.resolve({ value: done ? undefined : chunks[index++], done: done });
            },
          };
        };
        return stream;
      }
      if (method === 'database.batchQuery') {
        return Promise.resolve({
          success: true,
          error: null,
          data: {
            results: payload.queries.map(function () {
              return { rows: [
                { hb_id: 14424, otzaria_id: 101, is_best: 1, confidence: 1 },
                { hb_id: 9021, otzaria_id: 102, is_best: 1, confidence: 1 },
              ] };
            }),
          },
        });
      }
      if (method === 'library.resolveBooks') {
        return Promise.resolve({
          success: true,
          error: null,
          data: payload.items.map(function (item) {
            if (item.id === 101) return { id: 101, type: 'text', source: 'library', bookId: 'שולחן ערוך', title: 'שולחן ערוך', categoryPath: '/הלכה/אורח חיים' };
            if (item.id === 102) return { id: 102, type: 'text', source: 'library', bookId: 'נודע ביהודה', title: 'נודע ביהודה', categoryPath: '/שו״ת/אחרונים' };
            return null;
          }),
        });
      }
      if (method === 'reader.openBook') {
        return Promise.resolve({ success: true, error: null, data: true });
      }
      if (method === 'app.openUrl') {
        console.log('[app.openUrl]', payload.url);
        return Promise.resolve({ success: true, error: null, data: true });
      }
      return Promise.resolve({ success: false, error: { code: 'unsupported', message: method }, data: null });
    },
    on: function (event, callback) {
      (listeners[event] = listeners[event] || []).push(callback);
    },
    off: function () {},
  };

  window.addEventListener('DOMContentLoaded', function () {
    var boot = {
      app: { platform: 'preview', version: '0.0.0', locale: 'he-IL', textDirection: 'rtl', devMode: true },
      plugin: { id: 'org.hebrewbooks2026.otzaria-search', version: '0.1.0' },
      theme: {
        mode: isDark ? 'dark' : 'light',
        colorScheme: isDark ? schemes.dark : schemes.light,
        typography: {
          fontFamily: 'FrankRuhlCLM',
          fontSize: 25,
          lineHeight: 1.5,
          commentatorsFontFamily: 'Shofar',
          commentatorsFontSize: 22,
        },
      },
      permissions: ['network.localhost', 'library.books.read', 'reader.open', 'search.fulltext.read', 'database.read', 'ui.feedback', 'app.open_url'],
    };
    (listeners['plugin.boot'] || []).forEach(function (callback) {
      callback(boot);
    });
    drive(params.get('screen'));
  });

  /* הפעלת המסלול עד למסך המבוקש, כדי לצלם אותו. */
  function drive(screen) {
    if (!screen || screen === 'library') return;
    if (screen === 'unified') {
      (listeners['search.requested'] || []).forEach(function (callback) {
        callback({
          itemId: 'include-hebrewbooks',
          request: { query: 'שבת', mode: 'exact', order: 'catalogue', limit: Number(params.get('limit') || 100), distance: 3, facets: ['/'] },
        });
      });
      if (params.get('loadMore') === '1') {
        waitFor('.load-more-row .action-button', function (button) { button.click(); });
      }
      // פתיחת כל ענפי עץ הניווט — כל לחיצה בונה את העץ מחדש, ולכן לוחצים
      // שוב ושוב על החץ המכווץ הראשון שנותר.
      if (params.get('expand') === '1') {
        waitFor('.nav-tree-chevron', function () {
          var passes = 0;
          var timer = setInterval(function () {
            var next = document.querySelector('.nav-tree-chevron:not(.expanded)');
            passes += 1;
            if (!next || passes > 40) return clearInterval(timer);
            next.click();
          }, 30);
        });
      }
      if (params.get('filter')) {
        waitFor('.slim-search-field input', function (input) {
          input.value = params.get('filter');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      if (params.get('menu') === '1') {
        waitFor('.nav-filter-button', function (button) { button.click(); });
      }
      return;
    }
    waitFor('.library-setup-view .action-button', function (button) {
      button.click();
      waitFor('.search-dialog input[type=search]', function (input) {
        input.value = 'שבת';
        if (screen === 'dialog') return;
        var submit = document.querySelector('.dialog-footer .action-button.recommended');
        submit.click();
        if (screen === 'results') return;
        waitFor('.result-card-body', function (card) {
          card.click();
          if (params.get('zoom')) {
            // סרגל הזום נעלם אחרי שתי שניות, ולכן לוחצים שוב ושוב כדי שיישאר
            // גלוי בזמן הצילום.
            waitFor('.pdf-page canvas', function () {
              setInterval(function () {
                document.querySelector('[aria-label="הגדל את התצוגה"]').click();
              }, 1200);
            });
          }
          var tab = params.get('tab');
          if (!tab) return;
          var index = { navigation: 0, search: 1, thumbnails: 2 }[tab];
          waitFor('.panel-tab', function () {
            document.querySelectorAll('.panel-tab')[index].click();
          });
        });
      });
    });
  }

  function waitFor(selector, callback) {
    var attempts = 0;
    var timer = setInterval(function () {
      var node = document.querySelector(selector);
      attempts += 1;
      if (node) {
        clearInterval(timer);
        callback(node);
      } else if (attempts > 200) {
        clearInterval(timer);
        console.warn('לא נמצא', selector);
      }
    }, 40);
  }
})();
