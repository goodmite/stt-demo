(function(window){

	
	var SERVER = "wss://dev-frontend-1093425665.us-east-1.elb.amazonaws.com/client/ws/speech";
	var SERVER_STATUS = "wss://dev-frontend-1093425665.us-east-1.elb.amazonaws.com/client/ws/status";
	var REFERENCE_HANDLER = "wss://dev-frontend-1093425665.us-east-1.elb.amazonaws.com/client/dynamic/reference";
	var CONTENT_TYPE = "content-type=audio/x-raw,+layout=(string)interleaved,+rate=(int)16000,+format=(string)S16LE,+channels=(int)1";
	// Send blocks 4 x per second 
	var INTERVAL = 250;
	var TAG_END_OF_SENTENCE = "EOS";
	var RECORDER_WORKER_PATH = 'static/lib/recorderWorker.js';

	//Error Codes
	var ERR_NETWORK = 2;
	var ERR_AUDIO = 3;
	var ERR_SERVER = 4;
	var ERR_CLIENT = 5;

	// Event codes
	var MSG_WAITING_MICROPHONE = 1;
	var MSG_MEDIA_STREAM_CREATED = 2;
	var MSG_INIT_RECORDER = 3;
	var MSG_RECORDING = 4;
	var MSG_SEND = 5;
	var MSG_SEND_EMPTY = 6;
	var MSG_SEND_EOS = 7;
	var MSG_WEB_SOCKET = 8;
	var MSG_WEB_SOCKET_OPEN = 9;
	var MSG_WEB_SOCKET_CLOSE = 10;
	var MSG_STOP = 11;
	var MSG_SERVER_CHANGED = 12;

	// Server status codes
	
	var SERVER_STATUS_CODE = {
		0: 'Success', 
		1: 'No speech', 
		2: 'Aborted', 
		9: 'No available', 
	};

	var Dictate = function(cfg) {
		var config = cfg || {};
		config.server = config.server || SERVER;
		config.audioSourceId = config.audioSourceId;
		config.serverStatus = config.serverStatus || SERVER_STATUS;
		config.referenceHandler = config.referenceHandler || REFERENCE_HANDLER;
		config.contentType = config.contentType || CONTENT_TYPE;
		config.interval = config.interval || INTERVAL;
		config.recorderWorkerPath = config.recorderWorkerPath || RECORDER_WORKER_PATH;
		config.onReadyForSpeech = config.onReadyForSpeech || function() {};
		config.onEndOfSpeech = config.onEndOfSpeech || function() {};
		config.onPartialResults = config.onPartialResults || function(data) {};
		config.onResults = config.onResults || function(data) {};
		config.onEndOfSession = config.onEndOfSession || function() {};
		config.onEvent = config.onEvent || function(e, data) {};
		config.onError = config.onError || function(e, data) {};
		config.rafCallback = config.rafCallback || function(time) {};
		if (config.onServerStatus) {
			monitorServerStatus();
		}

		// Initialized by init()
		var audioContext;
		var recorder;
		// Initialized by startListening()
		var ws;
		var intervalKey;
		// Initialized during construction
		var wsServerStatus;

		// Returns the configuration
		this.getConfig = function() {
			return config;
		}

		// Set up the recorder (incl. asking permission)
		// Initializes audioContext
		// Can be called multiple times.
		// TODO: call something on success (MSG_INIT_RECORDER is currently called)
		this.init = function() {
			var audioSourceConstraints = {};
			config.onEvent(MSG_WAITING_MICROPHONE, "Waiting for approval to access your microphone ...");
			try {
				window.AudioContext = window.AudioContext || window.webkitAudioContext;
				navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
				window.URL = window.URL || window.webkitURL;
				audioContext = new AudioContext();
			} catch (e) {
				
				config.onError(ERR_CLIENT, "Error initializing Web Audio browser: " + e);
			}

			if (navigator.getUserMedia) {
				if(config.audioSourceId) {
					audioSourceConstraints.audio = {
						optional: [{ sourceId: config.audioSourceId }]
					};
				} else {
					audioSourceConstraints.audio = true;
				}
				navigator.getUserMedia(audioSourceConstraints, startUserMedia, function(e) {
					config.onError(ERR_CLIENT, "No live audio input in this browser: " + e);
				});
			} else {
				config.onError(ERR_CLIENT, "No user media support");
			}
		}

		// Start recording and transcribing
		this.startListening = function() {
			if (! recorder) {
				config.onError(ERR_AUDIO, "Recorder undefined");
				return;
			}

			if (ws) {
				cancel();
			}

			try {
				ws = createWebSocket();
			} catch (e) {
				config.onError(ERR_CLIENT, "No web socket support in this browser!");
			}
		}

		// Stop listening, i.e. recording and sending of new input.
		this.stopListening = function() {
			// Stop the regular sending of audio
			clearInterval(intervalKey);
			// Stop recording
			if (recorder) {
				recorder.stop();
				config.onEvent(MSG_STOP, 'Stopped recording');
				// Push the remaining audio to the server
				recorder.export16kMono(function(blob) {
					socketSend(blob);
					socketSend(TAG_END_OF_SENTENCE);
					recorder.clear();
				}, 'audio/x-raw');
				config.onEndOfSpeech();
			} else {
				config.onError(ERR_AUDIO, "Recorder undefined");
			}
		}

		// Cancel everything without waiting on the server
		this.cancel = function() {
			// Stop the regular sending of audio (if present)
			clearInterval(intervalKey);
			if (recorder) {
				recorder.stop();
				recorder.clear();
				config.onEvent(MSG_STOP, 'Stopped recording');
			}
			if (ws) {
				ws.close();
				ws = null;
			}
		}

		// Sets the URL of the speech server
		this.setServer = function(server) {
			config.server = server;
			config.onEvent(MSG_SERVER_CHANGED, 'Server changed: ' + server);
		}
		
		//Sets the Params of the speech server
		this.setParams = function() {
			config.lang_local=$("#langlocal").val();
			config.alt_lang=$("#altlang").val();
			config.sample_rate=$("#samplerate").val();
			config.model_name=$("#modelname").val();
		}		

		// Sets the URL of the speech server status server
		this.setServerStatus = function(serverStatus) {
			config.serverStatus = serverStatus;

			if (config.onServerStatus) {
				monitorServerStatus();
			}

			config.onEvent(MSG_SERVER_CHANGED, 'Server status server changed: ' + serverStatus);
		}

		// Sends reference text to speech server
		this.submitReference = function submitReference(text, successCallback, errorCallback) {
			var headers = {}
			if (config["user_id"]) {
				headers["User-Id"] = config["user_id"]
			}
			if (config["content_id"]) {
				headers["Content-Id"] = config["content_id"]
			}
			$.ajax({
				url: config.referenceHandler,
				type: "POST",
				headers: headers,
				data: text,
				dataType: "text",
				success: successCallback,
				error: errorCallback,
			});
		}

		
		function startUserMedia(stream) {
			var input = audioContext.createMediaStreamSource(stream);
			config.onEvent(MSG_MEDIA_STREAM_CREATED, 'Media stream created');
                        
                        window.source = input;
                        
			// make the analyser available in window context
			window.userSpeechAnalyser = audioContext.createAnalyser();
			input.connect(window.userSpeechAnalyser);

			config.rafCallback();

			recorder = new Recorder(input, { workerPath : config.recorderWorkerPath });
			config.onEvent(MSG_INIT_RECORDER, 'Recorder initialized');
		}

		function socketSend(item) {
			if (ws) {
				var state = ws.readyState;
				if (state == 1) {
					// If item is an audio blob
					if (item instanceof Blob) {
						if (item.size > 0) {
							ws.send(item);
							config.onEvent(MSG_SEND, 'Send: blob: ' + item.type + ', ' + item.size);
						} else {
							config.onEvent(MSG_SEND_EMPTY, 'Send: blob: ' + item.type + ', EMPTY');
						}
					// Otherwise it's the EOS tag (string)
					} else {
						ws.send(item);
						config.onEvent(MSG_SEND_EOS, 'Send tag: ' + item);
					}
				} else {
					config.onError(ERR_NETWORK, 'WebSocket: readyState!=1: ' + state + ": failed to send: " + item);
				}
			} else {
				config.onError(ERR_CLIENT, 'No web socket connection: failed to send: ' + item);
			}
		}


		function createWebSocket() {
			
			var url = config.server + '?' + config.contentType;
			if (config["user_id"]) {
				url += '&user-id=' + config["user_id"]
			}
			if (config["content_id"]) {
				url += '&content-id=' + config["content_id"]
			}
			if (config["model_name"]) {
				url += '&model-name=' + config["model_name"]
			}
			if (config["alt_lang"]) {
				url += '&alt-lang=' + config["alt_lang"]
			}
			if (config["lang_local"]) {
				url += '&lang-local=' + config["lang_local"]
			}
			if (config["sample_rate"]) {
				url += '&sample-rate=' + config["sample_rate"]	
			}
                        //console.log("first try")
			var ws = new WebSocket(url);

			ws.onmessage = function(e) {
				var data = e.data;
				config.onEvent(MSG_WEB_SOCKET, data);
				if (data instanceof Object && ! (data instanceof Blob)) {
					config.onError(ERR_SERVER, 'WebSocket: onEvent: got Object that is not a Blob');
				} else if (data instanceof Blob) {
					config.onError(ERR_SERVER, 'WebSocket: got Blob');
				} else {
					var res = JSON.parse(data);
					if (res.status == 0) {
						if (res.result) {
							if (res.result.final) {
								config.onResults(res.result.hypotheses);
							} else {
								config.onPartialResults(res.result.hypotheses);
							}
						}
					} else {
						config.onError(ERR_SERVER, 'Server error: ' + res.status + ': ' + getDescription(res.status));
					}
				}
			}

			// Start recording only if the socket becomes open
			ws.onopen = function(e) {
				intervalKey = setInterval(function() {
					recorder.export16kMono(function(blob) {
						socketSend(blob);
						recorder.clear();
					}, 'audio/x-raw');
				}, config.interval);
				// Start recording
				recorder.record();
				config.onReadyForSpeech();
				config.onEvent(MSG_WEB_SOCKET_OPEN, e);
			};

			
			ws.onclose = function(e) {
				var code = e.code;
				var reason = e.reason;
				var wasClean = e.wasClean;
				
				config.onEndOfSession();
				config.onEvent(MSG_WEB_SOCKET_CLOSE, e.code + "/" + e.reason + "/" + e.wasClean);
			};

			ws.onerror = function(e) {
				var data = e.data;
				config.onError(ERR_NETWORK, data);
			}

			return ws;
		}


		function monitorServerStatus() {
			if (wsServerStatus) {
				wsServerStatus.close();
			}
			wsServerStatus = new WebSocket(config.serverStatus);
			wsServerStatus.onmessage = function(evt) {
				config.onServerStatus(JSON.parse(evt.data));
			};
		}


		function getDescription(code) {
			if (code in SERVER_STATUS_CODE) {
				return SERVER_STATUS_CODE[code];
			}
			return "Unknown error";
		}

	};

	
	var Transcription = function(cfg) {
		var index = 0;
		var list = [];

		this.add = function(text, isFinal) {
			list[index] = text;
			if (isFinal) {
				index++;
			}
		}

		this.toString = function() {
			return list.join('. ');
		}
	}

	window.Dictate = Dictate;
	window.Transcription = Transcription;

})(window);
