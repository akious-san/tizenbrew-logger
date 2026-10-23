(function () {
    'use strict';

    var REPORT_URL = 'http://127.0.0.1:18765/v1/report';
    var CHECK_URL = 'http://127.0.0.1:18765/v1/id-check';
    var SHELL_URL = 'http://127.0.0.1:18765/v1/shell';
    var MAX_REPORT_BYTES = 16384;
    var MAX_CHECK_BYTES = 65536;
    var MAX_SHELL_BYTES = 262144;
    var permissionChecks = Object.freeze({
        source: 'PermissionChecks',
        command: [
            "(",
            "set +e",
            "command printf '=== IDENTITY AND RESTRICTIONS ===\\n'",
            "command /usr/bin/id",
            "command pwd",
            "command /usr/bin/grep -E '^(Name|Uid|Gid|Groups|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):' /proc/$$/status",
            "command /usr/bin/cat /proc/$$/attr/current",
            "command printf '\\n=== MOUNTS AND DIRECTORIES ===\\n'",
            "command /usr/bin/grep -E ' / | /(usr|lib|opt|mnt/systemrw|home|tmp)(/| )' /proc/$$/mounts",
            "command /usr/bin/ls -ld /lib /usr/lib /opt /mnt/systemrw",
            "command printf '\\n=== LIBRARY ACCESS ===\\n'",
            "for p in /usr/lib/libCLogger.so /usr/lib/libvoltKPIBridge.so /usr/lib/libvoltEngine.so.1.22.4",
            "do",
            "    command printf '\\n%s\\n' \"$p\"",
            "    command /usr/bin/ls -l \"$p\"",
            "    if command [ -w \"$p\" ]",
            "    then",
            "        command printf 'WRITE_CHECK: YES\\n'",
            "    else",
            "        command printf 'WRITE_CHECK: NO OR UNAVAILABLE\\n'",
            "    fi",
            "    if command /usr/bin/head -c 4 \"$p\" > /dev/null",
            "    then",
            "        command printf 'READ: OK\\n'",
            "    else",
            "        command printf 'READ: FAILED (see standard error)\\n'",
            "    fi",
            "done",
            "if command [ -w /usr/lib ]",
            "then",
            "    command printf '\\n/usr/lib DIRECTORY_WRITE_CHECK: YES\\n'",
            "else",
            "    command printf '\\n/usr/lib DIRECTORY_WRITE_CHECK: NO OR UNAVAILABLE\\n'",
            "fi",
            "command printf '\\n=== SHELL LIBRARY MAPPINGS (first 20 lines) ===\\n'",
            "command /usr/bin/grep '\\.so' /proc/$$/maps | command /usr/bin/head -n 20",
            "command printf '\\n=== PARENT SERVICE LIBRARY MAPPINGS (first 20 lines) ===\\n'",
            "command /usr/bin/grep '\\.so' /proc/$PPID/maps | command /usr/bin/head -n 20",
            "command printf '\\n=== PERMISSION CHECKS FINISHED ===\\n'",
            ")"
        ].join('\n')
    });
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
    var shellStart = document.getElementById('shell-start');
    var shellCommand = document.getElementById('shell-command');
    var shellSend = document.getElementById('shell-send');
    var shellPermissions = document.getElementById('shell-permissions');
    var shellStop = document.getElementById('shell-stop');
    var shellRefresh = document.getElementById('shell-refresh');
    var shellStatus = document.getElementById('shell-status');
    var shellDetail = document.getElementById('shell-detail');
    var shellStdout = document.getElementById('shell-stdout');
    var shellStderr = document.getElementById('shell-stderr');
    var shellStdoutDetail = document.getElementById('shell-stdout-detail');
    var shellStderrDetail = document.getElementById('shell-stderr-detail');
    var shellView = { status: 'Idle' };
    var shellSnapshot = { status: 'Unavailable' };
    var shellPoll = { status: 'Idle' };
    var shellInput = { status: 'None' };
    var shellPage = { status: 'Active' };
    var commandRevision = 0;

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

    // Views share bounded JSON transport. Only shell actions supply a JSON body.
    function requestJson(method, url, maximum, callback, payload) {
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
        request.onerror = function () { reject('The local service could not be reached.'); };
        request.ontimeout = function () { reject('The local service did not respond within three seconds.'); };
        request.onabort = function () { reject('The request ended before a response was received.'); };
        try {
            if (typeof payload !== 'undefined') {
                request.setRequestHeader('Content-Type', 'application/json');
                request.send(JSON.stringify(payload));
            } else {
                request.send();
            }
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

    function validSequence(value) {
        return validValue('integer', value) && value <= 9007199254740991;
    }

    function validReason(value) {
        return boundedString(value, 64) && /^[A-Za-z][A-Za-z0-9]*$/.test(value);
    }

    function validShellStream(stream) {
        return stream && validSequence(stream.bytes) && stream.bytes <= 16384 &&
            typeof stream.text === 'string' && stream.text.length <= stream.bytes &&
            validSequence(stream.droppedBytes);
    }

    function validShellTermination(termination) {
        if (!termination || typeof termination !== 'object' ||
                (own.call(termination, 'scope') &&
                ['ProcessGroup', 'Child'].indexOf(termination.scope) < 0)) {
            return false;
        }
        if (termination.status === 'NotRequested') {
            return !own.call(termination, 'signal');
        }
        return ['Requested', 'RequestFailed'].indexOf(termination.status) >= 0 &&
            ['SIGTERM', 'SIGKILL'].indexOf(termination.signal) >= 0;
    }

    function validShellCommand(command) {
        return typeof command === 'string' && /\S/.test(command) &&
            command.indexOf('\u0000') < 0 && responseWithinLimit(command, 4096);
    }

    function validLastInput(input, nextSequence) {
        if (!input || typeof input !== 'object') {
            return false;
        }
        if (input.status === 'None') {
            return nextSequence === 1 && !own.call(input, 'sequence') && !own.call(input, 'command');
        }
        return input.status === 'Submitted' && validSequence(input.sequence) && input.sequence >= 1 &&
            input.sequence === nextSequence - 1 && validShellCommand(input.command);
    }

    function validShell(envelope) {
        if (!envelope || envelope.moduleId !== 'tizenbrew-runtime-identity' ||
                envelope.schemaVersion !== 1 || envelope.shellId !== 'owner-shell' ||
                typeof envelope.token !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.token) ||
                !envelope.settings || !envelope.session || !envelope.outcome) {
            return false;
        }
        var settings = envelope.settings;
        if (settings.file !== '/bin/sh' || !Array.isArray(settings.args) ||
                settings.args.length !== 1 || settings.args[0] !== '-s' ||
                settings.maxInputBytes !== 4096 || settings.maxOutputBytesPerStream !== 16384 ||
                settings.idleTimeoutMs !== 300000 || settings.sessionTimeoutMs !== 900000) {
            return false;
        }
        var session = envelope.session;
        if (!validSequence(session.id) || !validSequence(session.nextInputSequence) ||
                session.nextInputSequence < 1 ||
                ['NotStarted', 'Running', 'Stopping', 'Closed', 'Failed'].indexOf(session.status) < 0 ||
                ['Ready', 'Backpressured', 'Closed'].indexOf(session.inputStatus) < 0 ||
                !validLastInput(session.lastInput, session.nextInputSequence) ||
                !validShellStream(session.stdout) || !validShellStream(session.stderr) ||
                !validExit(session.exit) || !validShellTermination(session.termination)) {
            return false;
        }
        if ((own.call(session, 'startedAtUtc') && !validTimestamp(session.startedAtUtc)) ||
                (own.call(session, 'completedAtUtc') && !validTimestamp(session.completedAtUtc)) ||
                (own.call(session, 'reasonCode') && !validReason(session.reasonCode))) {
            return false;
        }
        if (session.status === 'NotStarted' && (session.id !== 0 ||
                own.call(session, 'startedAtUtc') || own.call(session, 'completedAtUtc'))) {
            return false;
        }
        if (['Running', 'Stopping'].indexOf(session.status) >= 0 &&
                (!validTimestamp(session.startedAtUtc) || own.call(session, 'completedAtUtc'))) {
            return false;
        }
        if (['Closed', 'Failed'].indexOf(session.status) >= 0 &&
                !validTimestamp(session.completedAtUtc)) {
            return false;
        }
        var outcome = envelope.outcome;
        return ['Read', 'Started', 'Written', 'Stopped', 'Replay', 'Rejected'].indexOf(outcome.status) >= 0 &&
            (!own.call(outcome, 'reasonCode') || validReason(outcome.reasonCode)) &&
            (outcome.status !== 'Rejected' || validReason(outcome.reasonCode));
    }

    function shellVisible() {
        return shellPage.status === 'Active' && document.hidden !== true;
    }

    function clearShellPoll() {
        if (shellPoll.status === 'Scheduled') {
            clearTimeout(shellPoll.timer);
        }
        shellPoll = { status: 'Idle' };
    }

    function shellCanStop(session) {
        return session.exit.status === 'NotObserved' && (session.status === 'Running' ||
            (session.status === 'Stopping' && session.termination.status === 'RequestFailed'));
    }

    function shellCanRunChecks(session) {
        return session.status === 'Running' && session.inputStatus === 'Ready' &&
            session.nextInputSequence === 1 && session.lastInput.status === 'None';
    }

    function updateShellControls() {
        var ready = shellPage.status === 'Active' && shellView.status === 'Ready' && shellSnapshot.status === 'Observed';
        var sessionStatus = shellSnapshot.status === 'Observed' ? shellSnapshot.value.session.status : 'Unknown';
        shellStart.disabled = !ready || ['NotStarted', 'Closed', 'Failed'].indexOf(sessionStatus) < 0;
        shellSend.disabled = !ready || sessionStatus !== 'Running' ||
            shellSnapshot.value.session.inputStatus !== 'Ready' ||
            shellInput.status === 'Awaiting' || !validShellCommand(shellCommand.value);
        shellPermissions.disabled = !ready || !shellCanRunChecks(shellSnapshot.value.session) ||
            shellInput.status === 'Awaiting';
        shellStop.disabled = !ready || !shellCanStop(shellSnapshot.value.session);
        shellRefresh.disabled = shellView.status === 'Pending' || shellPage.status !== 'Active';
        shellCommand.disabled = shellSnapshot.status !== 'Observed' || sessionStatus !== 'Running';
    }

    function scheduleShellRead() {
        clearShellPoll();
        if (!shellVisible() || shellView.status === 'Pending' || shellSnapshot.status !== 'Observed' ||
                ['Running', 'Stopping'].indexOf(shellSnapshot.value.session.status) < 0) {
            return;
        }
        var scheduled = { status: 'Scheduled' };
        shellPoll = scheduled;
        scheduled.timer = setTimeout(function () {
            if (shellPoll !== scheduled) {
                return;
            }
            shellPoll = { status: 'Idle' };
            loadShell();
        }, 1000);
    }

    function renderShellStream(element, text) {
        var follow = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
        var display = text || '(empty)';
        if (element.textContent !== display) {
            element.textContent = display;
            if (follow) {
                element.scrollTop = element.scrollHeight;
            }
        }
    }

    function renderShell(envelope, message) {
        var session = envelope.session;
        var detail = '';
        if (session.status === 'Running') {
            detail = session.inputStatus === 'Backpressured' ?
                'Input is paused while the shell catches up. ' : 'Ready for a command. ';
        } else if (session.status === 'NotStarted') {
            detail = 'Choose Start shell to begin. ';
        } else if (session.status === 'Stopping') {
            detail = session.exit.status === 'Observed' ?
                'The shell exited; collecting remaining output. ' : 'Waiting for the shell to close. ';
        } else if (session.status === 'Failed') {
            detail = 'The shell could not start. ';
        } else if (session.status === 'Closed') {
            detail = 'The session closed. Start shell opens a new session. ';
        }
        shellStatus.textContent = 'Shell: ' + session.status + '. ' + message;
        if (session.reasonCode) {
            detail += session.reasonCode + '. ';
        }
        if (session.exit.status === 'Observed') {
            detail += 'Exit ' + session.exit.kind.toLowerCase() + ': ' + session.exit.value + '. ';
        }
        if (session.termination.status === 'Requested') {
            detail += session.exit.status === 'Observed' ? 'A stop was requested. ' :
                'A stop was requested; waiting to observe shell exit. ';
        } else if (session.termination.status === 'RequestFailed') {
            detail += 'The stop request failed. ' + (shellCanStop(session) ? 'Choose Stop shell to try stopping again. ' : '');
        }
        if (shellInput.status === 'Awaiting') {
            detail += 'Previous input delivery remains unresolved; the typed command is retained. ';
        }
        shellDetail.textContent = detail;
        renderShellStream(shellStdout, session.stdout.text);
        renderShellStream(shellStderr, session.stderr.text);
        shellStdoutDetail.textContent = session.stdout.bytes + ' retained bytes; ' + session.stdout.droppedBytes + ' dropped bytes.';
        shellStderrDetail.textContent = session.stderr.bytes + ' retained bytes; ' + session.stderr.droppedBytes + ' dropped bytes.';
        updateShellControls();
    }

    function reconcileShellInput(envelope) {
        if (shellInput.status !== 'Awaiting') {
            return { status: 'NoInput', message: '' };
        }
        var input = shellInput;
        var session = envelope.session;
        function resolved(status, message) {
            shellInput = { status: 'None' };
            return { status: status, source: input.source, message: message };
        }
        if (session.id !== input.sessionId) {
            return resolved('SessionChanged', 'The session changed; the typed command was retained.');
        }
        if (session.reasonCode === 'InputWriteFailed' || envelope.outcome.reasonCode === 'InputWriteFailed') {
            return resolved('WriteFailed', 'Command write failed; the typed command was retained.');
        }
        if (envelope.outcome.status === 'Rejected') {
            return resolved('Rejected', 'The typed command was retained.');
        }
        if (session.lastInput.status === 'Submitted' && session.lastInput.sequence === input.sequence &&
                session.lastInput.command === input.command) {
            if (input.source === 'Editor' && commandRevision === input.revision && shellCommand.value === input.command) {
                shellCommand.value = '';
                commandRevision += 1;
            }
            return resolved('Received', input.source === 'PermissionChecks' ?
                'Permission checks received. Results appear below; receipt does not confirm completion.' :
                'Command received; completion is not confirmed.');
        }
        if (session.nextInputSequence === input.sequence) {
            return resolved('NotAccepted', 'Input was not accepted; the typed command was retained.');
        }
        if (session.nextInputSequence > input.sequence) {
            return resolved('ConflictingInput', 'Another input was accepted. The typed command was retained; nothing was resent.');
        }
        return { status: 'Unresolved', source: input.source,
            message: 'Input delivery could not be confirmed from this sequence; the typed command was retained.' };
    }

    function shellOutcomeMessage(outcome, session) {
        if (outcome.status === 'Rejected') {
            return 'Action rejected (' + outcome.reasonCode + ').';
        }
        if (outcome.status === 'Started') {
            if (session.status === 'Failed') {
                return 'The shell could not start.';
            }
            return session.status === 'Running' ? 'Shell started. Commands share this session.' : 'Shell start attempted.';
        }
        if (outcome.status === 'Stopped') {
            return 'Stop requested. Refresh reads the observed state.';
        }
        if (outcome.status === 'Written') {
            return 'Command received; completion is not confirmed.';
        }
        if (outcome.status === 'Replay') {
            return 'The service acknowledged an action already received.';
        }
        return '';
    }

    function loadShell(action, selection) {
        if (shellView.status === 'Pending' || !shellVisible()) {
            return;
        }
        if (action && (shellView.status !== 'Ready' || shellSnapshot.status !== 'Observed')) {
            return;
        }
        var payload;
        if (action) {
            var session = shellSnapshot.value.session;
            if ((action === 'start' && ['NotStarted', 'Closed', 'Failed'].indexOf(session.status) < 0) ||
                    (action === 'input' && session.status !== 'Running') ||
                    (action === 'stop' && !shellCanStop(session))) {
                return;
            }
            payload = { token: shellSnapshot.value.token, action: action, sessionId: session.id };
            if (action === 'input') {
                if (session.inputStatus !== 'Ready' || shellInput.status === 'Awaiting') {
                    return;
                }
                var selected = selection || { source: 'Editor', command: shellCommand.value };
                if (selected.source === 'PermissionChecks' && !shellCanRunChecks(session)) {
                    shellStatus.textContent = 'Start a new shell session to run permission checks.';
                    return;
                }
                var command = selected.command;
                if (!validShellCommand(command)) {
                    shellStatus.textContent = 'Enter a nonblank command of at most 4096 UTF-8 bytes with no NUL characters.';
                    return;
                }
                payload.sequence = session.nextInputSequence;
                payload.command = command;
                shellInput = {
                    status: 'Awaiting', sessionId: session.id, sequence: payload.sequence,
                    source: selected.source, command: command, revision: commandRevision
                };
            }
        }
        clearShellPoll();
        var pending = { status: 'Pending', action: action || 'read', focus: document.activeElement };
        shellView = pending;
        updateShellControls();
        if (action) {
            shellStatus.textContent = action === 'input' ?
                (shellInput.source === 'PermissionChecks' ? 'Sending read-only permission checks...' : 'Sending command...') :
                (action === 'start' ? 'Starting shell...' : 'Requesting stop...');
        }
        requestJson(action ? 'POST' : 'GET', SHELL_URL, MAX_SHELL_BYTES, function (outcome) {
            if (shellView !== pending) {
                return;
            }
            if (outcome.status !== 'Received' || !validShell(outcome.value)) {
                shellView = { status: 'Unavailable' };
                shellStatus.textContent = 'Shell state unavailable. ' +
                    (outcome.message || 'Its identity or format did not match this module.');
                shellDetail.textContent = action ?
                    'Delivery is unknown. Refresh shell reads state; no action will be retried automatically.' :
                    'Refresh shell reads state. Existing output is the last observed snapshot.';
                updateShellControls();
                if (shellVisible() && (pending.focus === shellStart || pending.focus === shellSend || pending.focus === shellPermissions || pending.focus === shellStop ||
                        (pending.focus === shellStatus && document.activeElement === shellStatus))) {
                    shellRefresh.focus();
                }
                scheduleShellRead();
                return;
            }
            var envelope = outcome.value;
            shellSnapshot = { status: 'Observed', value: envelope };
            shellView = { status: 'Ready' };
            var receipt = reconcileShellInput(envelope);
            var inputMessage = receipt.message;
            renderShell(envelope, inputMessage && envelope.outcome.status === 'Rejected' ?
                shellOutcomeMessage(envelope.outcome, envelope.session) + ' ' + inputMessage :
                (inputMessage || shellOutcomeMessage(envelope.outcome, envelope.session)));
            if (shellVisible() && receipt.status === 'Received' && receipt.source === 'PermissionChecks' &&
                    (document.activeElement === document.body || document.activeElement === shellPermissions ||
                    document.activeElement === shellRefresh || document.activeElement === shellStatus)) {
                shellStdout.focus();
            } else if (shellVisible() && action && pending.focus === shellPermissions &&
                    (document.activeElement === document.body || document.activeElement === shellPermissions ||
                    document.activeElement === shellStatus)) {
                shellRefresh.focus();
            } else if (shellVisible() && action && (pending.focus === shellStart || pending.focus === shellSend) && !shellCommand.disabled) {
                shellCommand.focus();
            } else if (shellVisible() && action && pending.focus === shellStop) {
                shellRefresh.focus();
            } else if (shellVisible() && ((action && pending.focus === shellStart) ||
                    (!action && pending.focus === shellStatus && document.activeElement === shellStatus))) {
                if (!shellStart.disabled) {
                    shellStart.focus();
                } else {
                    shellRefresh.focus();
                }
            }
            scheduleShellRead();
        }, payload);
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
    shellStart.addEventListener('click', function () { loadShell('start'); });
    shellSend.addEventListener('click', function () { loadShell('input'); });
    shellPermissions.addEventListener('click', function () { loadShell('input', permissionChecks); });
    shellStop.addEventListener('click', function () { loadShell('stop'); });
    shellRefresh.addEventListener('click', function () { loadShell(); });
    shellCommand.addEventListener('input', function () {
        commandRevision += 1;
        updateShellControls();
    });
    document.addEventListener('keydown', function (event) {
        var code = event.keyCode;
        var active = document.activeElement;
        if (active === shellStdout || active === shellStderr) {
            var outputTarget;
            if (code === 37 || code === 39) {
                outputTarget = active === shellStdout ? shellStderr : shellStdout;
            } else if (code === 38 && active.scrollTop <= 0) {
                outputTarget = active === shellStderr ? shellStdout : (!shellSend.disabled ? shellSend : shellRefresh);
            } else if (code === 40 && active === shellStdout &&
                    active.scrollTop + active.clientHeight >= active.scrollHeight - 1) {
                outputTarget = shellStderr;
            } else if (code === 27 || code === 461 || code === 10009) {
                outputTarget = !shellSend.disabled ? shellSend : shellRefresh;
            }
            if (outputTarget && !outputTarget.disabled) {
                event.preventDefault();
                event.stopPropagation();
                outputTarget.focus();
            }
            return;
        }
        if (active === shellCommand) {
            if (code === 13 && event.ctrlKey) {
                event.preventDefault();
                if (event.repeat !== true && !shellSend.disabled) {
                    loadShell('input');
                }
            } else if (code === 27 || code === 461 || code === 10009) {
                event.preventDefault();
                event.stopPropagation();
                if (!shellSend.disabled) {
                    shellSend.focus();
                } else if (!shellStop.disabled) {
                    shellStop.focus();
                } else if (!shellRefresh.disabled) {
                    shellRefresh.focus();
                }
            }
            // Ordinary Enter and arrows belong to the editor, including vertical scroll.
            return;
        }
        var controls = [shellStart, shellStop, shellRefresh, shellPermissions, shellSend, shellStdout, shellStderr, refresh, runCheck];
        var index = controls.indexOf(active);
        if (index < 0) {
            return;
        }
        if (code === 40 && (active === shellSend || active === shellPermissions)) {
            event.preventDefault();
            shellStdout.focus();
            return;
        }
        if (((code === 40 && (active === shellStart || active === shellStop || active === shellRefresh)) ||
                (code === 38 && active === shellSend)) && !shellCommand.disabled) {
            event.preventDefault();
            shellCommand.focus();
            return;
        }
        if (code !== 37 && code !== 39) {
            // Up/Down otherwise retain normal page and output scrolling.
            return;
        }
        var direction = code === 37 ? -1 : 1;
        for (var distance = 1; distance < controls.length; distance += 1) {
            var target = controls[(index + direction * distance + controls.length) % controls.length];
            if (!target.disabled) {
                event.preventDefault();
                target.focus();
                return;
            }
        }
    });
    function leaveShellPage() {
        shellPage = { status: 'Left' };
        clearShellPoll();
        // Keep the pending request owned until completion; returning cannot overlap it with another request.
        updateShellControls();
    }
    window.addEventListener('pagehide', leaveShellPage);
    window.addEventListener('beforeunload', leaveShellPage);
    window.addEventListener('pageshow', function () {
        if (shellPage.status === 'Left') {
            shellPage = { status: 'Active' };
            loadShell();
        }
    });
    document.addEventListener('visibilitychange', function () {
        clearShellPoll();
        if (shellVisible()) {
            loadShell();
        }
    });
    loadReport();
    loadCheck('GET', 0);
    shellStatus.focus();
    loadShell();
}());
