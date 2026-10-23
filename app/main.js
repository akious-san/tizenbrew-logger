(function () {
    'use strict';

    var REPORT_URL = 'http://127.0.0.1:18765/v1/report';
    var CHECK_URL = 'http://127.0.0.1:18765/v1/id-check';
    var MAX_REPORT_BYTES = 16384;
    var MAX_CHECK_BYTES = 65536;
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
    var runCheck = document.getElementById('run-check');
    var checkStatus = document.getElementById('check-status');
    var checkDetail = document.getElementById('check-detail');
    var checkOutput = document.getElementById('check-output');
    var stdout = document.getElementById('stdout');
    var stderr = document.getElementById('stderr');
    var view = { status: 'Idle' };
    var checkView = { status: 'Idle' };

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

    function responseWithinLimit(text, maximum) {
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
            if (bytes > maximum) {
                return false;
            }
        }
        return true;
    }

    function validTimestamp(value) {
        return boundedString(value, 32) &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !isNaN(Date.parse(value));
    }

    // Both views use the same bounded JSON transport; neither GET starts a process.
    function requestJson(method, url, maximum, callback) {
        var finished = false;
        function finishRequest(outcome) {
            if (!finished) {
                finished = true;
                callback(outcome);
            }
        }
        function reject(message) {
            finishRequest({ status: 'Unavailable', message: message });
        }
        var request;
        try {
            request = new XMLHttpRequest();
            request.open(method, url, true);
            request.timeout = 3000;
        } catch (error) {
            reject('This browser could not prepare the local request.');
            return;
        }
        request.onprogress = function (event) {
            if (event.loaded > maximum) {
                reject('The response exceeded its size limit.');
                request.abort();
            }
        };
        request.onload = function () {
            if (finished) {
                return;
            }
            if ((request.status !== 200 && !(method === 'POST' && request.status === 202)) ||
                    !responseWithinLimit(request.responseText, maximum)) {
                reject('The local service did not return an accepted response.');
                return;
            }
            var value;
            try {
                value = JSON.parse(request.responseText);
            } catch (error) {
                reject('The response was not valid JSON.');
                return;
            }
            finishRequest({ status: 'Received', value: value });
        };
        request.onerror = function () { reject('The local service could not be reached. Choose Refresh report to read its state.'); };
        request.ontimeout = function () { reject('The local service did not respond within three seconds.'); };
        request.onabort = function () { reject('The request ended before a response was received.'); };
        try {
            // No request body, custom headers, or command arguments are accepted.
            request.send();
        } catch (error) {
            reject('This page could not contact its local service.');
        }
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

    function validStream(stream) {
        return stream && validValue('integer', stream.bytes) && stream.bytes <= 4096 &&
            typeof stream.text === 'string' && stream.text.length <= stream.bytes;
    }

    function validExit(exit) {
        if (!exit || typeof exit !== 'object') {
            return false;
        }
        if (exit.status === 'NotObserved') {
            return !own.call(exit, 'kind') && !own.call(exit, 'value');
        }
        if (exit.status !== 'Observed') {
            return false;
        }
        if (exit.kind === 'Code') {
            return typeof exit.value === 'number' && isFinite(exit.value) &&
                Math.floor(exit.value) === exit.value && Math.abs(exit.value) <= 2147483648;
        }
        return exit.kind === 'Signal' && typeof exit.value === 'string' && /^[A-Z0-9]{1,32}$/.test(exit.value);
    }

    function validCheck(check) {
        if (!check || check.moduleId !== 'tizenbrew-runtime-identity' || check.schemaVersion !== 1 ||
                check.checkId !== 'fixed-posix-id' || !check.command ||
                check.command.file !== '/usr/bin/id' || !Array.isArray(check.command.args) ||
                check.command.args.length !== 0 || check.command.timeoutMs !== 3000 ||
                check.command.maxOutputBytesPerStream !== 4096 || !check.result) {
            return false;
        }
        var result = check.result;
        var terminalFields = ['completedAtUtc', 'stdout', 'stderr', 'exit', 'termination'];
        if (result.status === 'NotRun' || result.status === 'Running') {
            if (terminalFields.some(function (name) { return own.call(result, name); })) {
                return false;
            }
            return result.status === 'NotRun' ? !own.call(result, 'startedAtUtc') : validTimestamp(result.startedAtUtc);
        }
        if (['Succeeded', 'Unavailable', 'Denied', 'TimedOut', 'OutputLimitExceeded', 'Failed'].indexOf(result.status) < 0 ||
                !validTimestamp(result.startedAtUtc) || !validTimestamp(result.completedAtUtc) ||
                !validStream(result.stdout) || !validStream(result.stderr) || !validExit(result.exit) || !result.termination) {
            return false;
        }
        var termination = result.termination;
        if (termination.status === 'NotRequested') {
            if (own.call(termination, 'signal')) {
                return false;
            }
        } else if ((termination.status !== 'Requested' && termination.status !== 'RequestFailed') ||
                termination.signal !== 'SIGKILL') {
            return false;
        }
        if (own.call(result, 'reasonCode') &&
                (!boundedString(result.reasonCode, 64) || !/^[A-Za-z][A-Za-z0-9]*$/.test(result.reasonCode))) {
            return false;
        }
        return result.status !== 'Succeeded' ||
            (result.exit.status === 'Observed' && result.exit.kind === 'Code' && result.exit.value === 0 &&
            termination.status === 'NotRequested');
    }

    function renderCheck(result) {
        runCheck.disabled = result.status !== 'NotRun';
        checkOutput.hidden = result.status === 'NotRun' || result.status === 'Running';
        if (result.status === 'NotRun') {
            checkStatus.textContent = 'Not run. Choose Run identity check to execute /usr/bin/id once.';
            checkDetail.textContent = 'No shell; no arguments. Three-second deadline; up to 4096 bytes per output stream.';
            return;
        }
        if (result.status === 'Running') {
            checkStatus.textContent = 'Identity check is running. Refresh report reads its current result.';
            checkDetail.textContent = 'Started at ' + result.startedAtUtc + ' (service clock).';
            return;
        }
        checkStatus.textContent = 'Identity check: ' + result.status + (result.reasonCode ? ' (' + result.reasonCode + ').' : '.');
        var detail = 'Started ' + result.startedAtUtc + '; completed ' + result.completedAtUtc + ' (service clock). ';
        detail += result.exit.status === 'Observed' ? 'Exit ' + result.exit.kind.toLowerCase() + ': ' + result.exit.value + '. ' : 'Exit was not observed. ';
        if (result.termination.status === 'Requested') {
            detail += 'SIGKILL was requested; process termination is not confirmed by this result. ';
        } else if (result.termination.status === 'RequestFailed') {
            detail += 'The SIGKILL request failed; process termination is not confirmed. ';
        }
        checkDetail.textContent = detail + 'This result is cached for this module instance.';
        stdout.textContent = result.stdout.text || '(empty)';
        stderr.textContent = result.stderr.text || '(empty)';
    }

    function loadCheck(method, remainingReads) {
        if (checkView.status === 'Reading') {
            return;
        }
        var pending = { status: 'Reading' };
        checkView = pending;
        var moveFocus = document.activeElement === runCheck;
        runCheck.disabled = true;
        if (moveFocus && !refresh.disabled) {
            refresh.focus();
        }
        checkOutput.hidden = true;
        checkStatus.textContent = method === 'POST' ? 'Requesting the fixed identity check...' : 'Reading identity check state...';
        checkDetail.textContent = '';
        requestJson(method, CHECK_URL, MAX_CHECK_BYTES, function (outcome) {
            if (checkView !== pending) {
                return;
            }
            if (outcome.status !== 'Received' || !validCheck(outcome.value)) {
                checkView = { status: 'Unavailable' };
                checkStatus.textContent = 'Identity check unavailable. ' + (outcome.message || 'Its identity or format did not match this module.');
                checkDetail.textContent = 'Choose Refresh report to read the state. This page will not retry execution.';
                return;
            }
            var ready = { status: 'Ready', result: outcome.value.result };
            checkView = ready;
            renderCheck(ready.result);
            if (ready.result.status === 'Running' && remainingReads > 0) {
                setTimeout(function () {
                    if (checkView === ready) {
                        loadCheck('GET', remainingReads - 1);
                    }
                }, remainingReads === 2 ? 250 : 3000);
            }
        });
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
        if (document.activeElement === document.body || document.activeElement === refresh) {
            refresh.focus();
        }
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

        requestJson('GET', REPORT_URL, MAX_REPORT_BYTES, function (outcome) {
            if (view !== pending) {
                return;
            }
            if (outcome.status !== 'Received') {
                unavailable(pending, 'Report unavailable. ' + outcome.message);
                return;
            }
            var report = outcome.value;
            if (!validReport(report)) {
                unavailable(pending, 'Report unavailable: its identity or format did not match this module.');
                return;
            }
            finish(pending, { status: 'Ready', message: 'Snapshot received. Each field has its own result.', report: report });
        });
    }

    refresh.addEventListener('click', function () {
        loadReport();
        loadCheck('GET', 0);
    });
    runCheck.addEventListener('click', function () {
        if (checkView.status === 'Ready' && checkView.result.status === 'NotRun') {
            loadCheck('POST', 2);
        }
    });
    document.addEventListener('keydown', function (event) {
        var code = event.keyCode;
        if ((code !== 37 && code !== 39) || (document.activeElement !== refresh && document.activeElement !== runCheck)) {
            return;
        }
        var target = document.activeElement === refresh ? runCheck : refresh;
        if (!target.disabled) {
            event.preventDefault();
            target.focus();
        }
    });
    loadReport();
    loadCheck('GET', 0);
    refresh.focus();
}());
