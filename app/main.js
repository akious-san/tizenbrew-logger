(function () {
    'use strict';

    var REPORT_URL = 'http://127.0.0.1:18765/v1/report';
    var MAX_REPORT_BYTES = 16384;
    var expectedFields = {
        'node.version': 'string',
        'node.platform': 'string',
        'node.architecture': 'string',
        'process.uid': 'integer',
        'process.gid': 'integer',
        'tizen.applicationId': 'string',
        'tizen.packageId': 'string',
        'tizen.platformVersion': 'string',
        'tizen.webService': 'boolean',
        'node.childProcess': 'string'
    };
    var own = Object.prototype.hasOwnProperty;
    var refresh = document.getElementById('refresh');
    var status = document.getElementById('status');
    var timestamp = document.getElementById('timestamp');
    var table = document.getElementById('report-table');
    var rows = document.getElementById('observations');
    var view = { status: 'Idle' };

    function boundedString(value, maximum) {
        return typeof value === 'string' && value.length > 0 && value.length <= maximum;
    }

    function validValue(type, value) {
        if (type === 'string') {
            return boundedString(value, 256);
        }
        if (type === 'integer') {
            return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value;
        }
        return type === 'boolean' && typeof value === 'boolean';
    }

    function responseWithinLimit(text) {
        var bytes = 0;
        for (var index = 0; index < text.length; index += 1) {
            var code = text.charCodeAt(index);
            if (code < 128) {
                bytes += 1;
            } else if (code < 2048) {
                bytes += 2;
            } else if (code >= 55296 && code <= 56319 && index + 1 < text.length &&
                    text.charCodeAt(index + 1) >= 56320 && text.charCodeAt(index + 1) <= 57343) {
                bytes += 4;
                index += 1;
            } else {
                bytes += 3;
            }
            if (bytes > MAX_REPORT_BYTES) {
                return false;
            }
        }
        return true;
    }

    function validObservation(observation, seen) {
        if (!observation || typeof observation !== 'object' ||
                !own.call(expectedFields, observation.id) || own.call(seen, observation.id) ||
                !boundedString(observation.label, 80) || !boundedString(observation.source, 256)) {
            return false;
        }
        seen[observation.id] = true;
        if (observation.status === 'Observed') {
            return own.call(observation, 'value') && !own.call(observation, 'reasonCode') &&
                validValue(expectedFields[observation.id], observation.value);
        }
        if (observation.status === 'Unavailable' || observation.status === 'Error') {
            return !own.call(observation, 'value') && boundedString(observation.reasonCode, 64) &&
                /^[A-Za-z][A-Za-z0-9]*$/.test(observation.reasonCode);
        }
        return false;
    }

    function validReport(report) {
        if (!report || report.moduleId !== 'tizenbrew-runtime-identity' || report.schemaVersion !== 1 ||
                report.source !== 'tizenbrew-service-process' ||
                !boundedString(report.collectedAtUtc, 32) ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.collectedAtUtc) ||
                isNaN(Date.parse(report.collectedAtUtc)) || !Array.isArray(report.observations) ||
                report.observations.length !== Object.keys(expectedFields).length) {
            return false;
        }
        var seen = Object.create(null);
        for (var index = 0; index < report.observations.length; index += 1) {
            if (!validObservation(report.observations[index], seen)) {
                return false;
            }
        }
        return true;
    }

    function cell(row, text, className) {
        var element = document.createElement('td');
        element.textContent = text;
        if (className) {
            element.className = className;
        }
        row.appendChild(element);
    }

    function renderReport(report) {
        while (rows.firstChild) {
            rows.removeChild(rows.firstChild);
        }
        for (var index = 0; index < report.observations.length; index += 1) {
            var observation = report.observations[index];
            var row = document.createElement('tr');
            cell(row, observation.label);
            cell(row, observation.status, observation.status.toLowerCase());
            cell(row, observation.status === 'Observed' ? String(observation.value) : observation.reasonCode);
            rows.appendChild(row);
        }
        timestamp.textContent = 'Snapshot collected at ' + report.collectedAtUtc + ' (service clock). Refresh reads this same snapshot.';
        table.hidden = false;
    }

    function finish(pending, outcome) {
        if (view !== pending) {
            return;
        }
        view = outcome;
        refresh.disabled = false;
        status.textContent = outcome.message;
        if (outcome.status === 'Ready') {
            renderReport(outcome.report);
        }
        refresh.focus();
    }

    function unavailable(pending, message) {
        finish(pending, { status: 'Unavailable', message: message });
    }

    function loadReport() {
        if (view.status === 'Loading') {
            return;
        }
        var pending = { status: 'Loading' };
        view = pending;
        refresh.disabled = true;
        table.hidden = true;
        timestamp.textContent = '';
        status.textContent = 'Reading the service report...';

        var request;
        try {
            request = new XMLHttpRequest();
            request.open('GET', REPORT_URL, true);
            request.timeout = 3000;
        } catch (error) {
            unavailable(pending, 'Report unavailable: this browser could not prepare the local request.');
            return;
        }
        request.onprogress = function (event) {
            if (event.loaded > MAX_REPORT_BYTES) {
                unavailable(pending, 'Report unavailable: the response exceeded its size limit.');
                request.abort();
            }
        };
        request.onload = function () {
            if (view !== pending) {
                return;
            }
            if (request.status !== 200 || !responseWithinLimit(request.responseText)) {
                unavailable(pending, 'Report unavailable: the local service did not return an accepted report.');
                return;
            }
            var report;
            try {
                report = JSON.parse(request.responseText);
            } catch (error) {
                unavailable(pending, 'Report unavailable: the response was not valid JSON.');
                return;
            }
            if (!validReport(report)) {
                unavailable(pending, 'Report unavailable: its identity or format did not match this module.');
                return;
            }
            finish(pending, { status: 'Ready', message: 'Snapshot received. Each field has its own result.', report: report });
        };
        request.onerror = function () {
            unavailable(pending, 'Report unavailable. If the service has just started, choose Refresh report.');
        };
        request.ontimeout = function () {
            unavailable(pending, 'Report unavailable: the local service did not respond within three seconds.');
        };
        request.onabort = function () {
            unavailable(pending, 'Report request ended before a snapshot was received.');
        };
        try {
            request.send();
        } catch (error) {
            unavailable(pending, 'Report unavailable: this page could not contact its local service.');
        }
    }

    refresh.addEventListener('click', loadReport);
    loadReport();
}());
