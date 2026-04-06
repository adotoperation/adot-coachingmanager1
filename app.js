// [설정] 백엔드 API 주소 - 로컬 테스트 시 자동으로 http://localhost:5000을 사용합니다.
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:5000' 
    : ''; // Vercel에 함께 배포되므로 상대 경로(/api/...)를 사용합니다.

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const loginView = document.getElementById('login-view');
    const mainView = document.getElementById('main-view');
    const logoutBtn = document.getElementById('logout-btn');
    
    // Coaching UI Elements
    const displayBranch = document.getElementById('display-branch');
    const displayName = document.getElementById('display-name');
    const webcamVideo = document.getElementById('webcam-video');
    const webcamCanvas = document.getElementById('webcam-canvas');
    const emotionResults = document.getElementById('emotion-results');
    
    // Gemini Interaction Elements
    const micBtn = document.getElementById('mic-btn');
    const micText = document.getElementById('mic-text');
    const chatStatus = document.getElementById('chat-status');
    const instructorText = document.getElementById('instructor-text');
    const geminiText = document.getElementById('gemini-text');
    const geminiAvatar = document.getElementById('gemini-avatar');
    const historyList = document.querySelector('.history-list');

    // Face API models URL (Using public CDN for demo purposes)
    const MODEL_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';
    
    let isModelsLoaded = false;
    let webcamStream = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let sessionTimer = null;
    let timeLeft = 15 * 60; // 15분
    let isSessionRunning = false;

    // 표정 분석을 위한 변수
    let lastLandmarks = null;
    let expressionHistory = {
        warmth: [],
        focus: [],
        energy: []
    };

    // ==========================================
    // [개발 환경용 임시 자동 로그인 로직]
    // 새로고침 시마다 로그인하는 번거로움을 줄이기 위함
    // ==========================================
    const isDevMode = false; // 배포 시엔 false로 변경
    
    if (isDevMode && loginView && mainView) {
        loginView.classList.remove('active');
        mainView.classList.add('active');
        
        const devBranch = '테스트지점';
        const devName = '개발자';
        const devId = 'DEV123';
        
        localStorage.setItem('instructorName', devName);
        localStorage.setItem('branchName', devBranch);
        localStorage.setItem('crmId', devId);

        if(displayBranch) displayBranch.textContent = devBranch;
        if(displayName) displayName.textContent = devName + " (" + devId + ")";
        
        loadHistory(devId);
        
        setTimeout(() => {
            initCoaching();
        }, 300); // 렌더링 후 초기화
    }
    // ==========================================

    // Handle Login Submit
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const branch = document.getElementById('branch').value;
            const crmId = document.getElementById('crmId').value;
            const password = document.getElementById('password').value;

            const submitBtn = loginForm.querySelector('.login-btn');
            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<span style="opacity: 0.8;">로그인 중...</span>';
            submitBtn.style.pointerEvents = 'none';
            
            try {
                const response = await fetch(`${API_BASE}/api/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ branch, crmId, password })
                });

                const data = await response.json();

                if (data.success) {
                    loginView.classList.remove('active');
                    mainView.classList.add('active');
                    
                    localStorage.setItem('instructorName', data.instructorName || '무명강사');
                    localStorage.setItem('branchName', branch);
                    localStorage.setItem('crmId', crmId);

                    // Update Instructor Info
                    if(displayBranch) displayBranch.textContent = branch;
                    if(displayName) displayName.textContent = (data.instructorName || "강사님") + " (" + crmId + ")";
                    
                    // Initialize Coaching functionalities
                    loadHistory(crmId);
                    initCoaching();
                } else {
                    alert(data.message);
                }
            } catch (error) {
                console.error("Login Error:", error);
                alert("서버 통신 오류가 발생했습니다.");
            } finally {
                submitBtn.innerHTML = originalText;
                submitBtn.style.pointerEvents = 'auto';
            }
        });
    }

    // Handle Logout
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            mainView.classList.remove('active');
            loginView.classList.add('active');
            
            const passwordField = document.getElementById('password');
            if(passwordField) passwordField.value = '';
            
            // Cleanup coaching session
            stopCoaching();
        });
    }



    async function loadHistory(crmId) {
        if (!historyList) return;
        
        try {
            historyList.innerHTML = '<li class="history-item">로딩 중...</li>';
            const response = await fetch(`${API_BASE}/api/history?crmId=${crmId}`);
            const data = await response.json();
            
            if (data.success && data.history && data.history.length > 0) {
                historyList.innerHTML = ''; // 초기화
                data.history.forEach(item => {
                    const li = document.createElement('li');
                    li.className = 'history-item';
                    li.innerHTML = `
                        <span class="date">${item.date}</span>
                    `;
                    li.style.cursor = 'pointer';
                    li.addEventListener('click', () => {
                        if (item.videoUrl && item.videoUrl !== 'None') {
                            openVideoModal(item.date, item.videoUrl);
                        } else {
                            alert("동영상 링크가 없습니다.");
                        }
                    });
                    historyList.appendChild(li);
                });
            } else {
                historyList.innerHTML = '<li class="history-item">이력이 없습니다.</li>';
            }
        } catch (err) {
            console.error("History Load Error:", err);
            historyList.innerHTML = '<li class="history-item">이력 로드 실패</li>';
        }
    }

    // 비디오 모달 제어
    const videoModal = document.getElementById('video-modal');
    const videoIframe = document.getElementById('video-iframe');
    const modalTitle = document.getElementById('modal-title');
    const closeModal = document.getElementById('close-modal');

    function openVideoModal(date, url) {
        if (!videoModal || !videoIframe) return;
        
        modalTitle.textContent = `${date} 코칭 세션 영상`;
        
        // 구글 드라이브 링크를 미리보기(preview) 모드로 변환
        let previewUrl = url;
        if (url.includes('drive.google.com')) {
            // URL 형태에 따른 변환 (/view?usp=sharing 등 포괄적 대응)
            const fileIdMatch = url.match(/\/file\/d\/([^\/]+)/);
            if (fileIdMatch && fileIdMatch[1]) {
                previewUrl = `https://drive.google.com/file/d/${fileIdMatch[1]}/preview`;
            }
        }
        
        videoIframe.src = previewUrl;
        videoModal.style.display = 'flex';
    }

    if (closeModal) {
        closeModal.addEventListener('click', () => {
            if (videoModal) videoModal.style.display = 'none';
            if (videoIframe) videoIframe.src = '';
        });
    }

    // 모달 바깥쪽 클릭 시 닫기
    window.addEventListener('click', (e) => {
        if (e.target === videoModal) {
            videoModal.style.display = 'none';
            videoIframe.src = '';
        }
    });

    // Initialize Coaching Session
    async function initCoaching() {
        // Face API 모델 로드 시작
        if (!isModelsLoaded) {
            try {
                chatStatus.textContent = "AI 분석 모델을 로드하고 있습니다...";
                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
                    faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
                ]);
                isModelsLoaded = true;
                console.log("✅ Face API 모델 로드 완료");
            } catch (err) {
                console.error("모델 로드 실패:", err);
                chatStatus.textContent = "AI 모델 로드 실패. 일부 기능이 제한될 수 있습니다.";
            }
        }
        
        // Fetch Personas from API
        try {
            const res = await fetch(`${API_BASE}/api/personas`);
            const data = await res.json();
            if(data.success) {
                const gradeSelect = document.getElementById('persona-grade');
                const levelSelect = document.getElementById('persona-level');
                const periodSelect = document.getElementById('persona-period');
                
                if(gradeSelect) {
                    data.grades.forEach(g => {
                        const opt = document.createElement('option');
                        opt.value = g; opt.textContent = g; opt.style.color = "black";
                        gradeSelect.appendChild(opt);
                    });
                }
                if(levelSelect) {
                    data.levels.forEach(l => {
                        const opt = document.createElement('option');
                        opt.value = l; opt.textContent = l; opt.style.color = "black";
                        levelSelect.appendChild(opt);
                    });
                }
                if(periodSelect) {
                    data.periods.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p; opt.textContent = p; opt.style.color = "black";
                        periodSelect.appendChild(opt);
                    });
                }
            }
        } catch (e) {
            console.error("Failed to load personas", e);
        }
        
        // --- 세션 시작 전 (로그인 즉시) 마이크/카메라 테스트 연결 ---
        try {
            // 시도 1: 카메라와 마이크 모두 요청
            try {
                webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (webcamVideo) {
                    webcamVideo.srcObject = webcamStream;
                    webcamVideo.muted = true; // prevent playback echo
                }
            } catch(e) {
                console.warn("카메라 로드 실패, 사전 마이크만 단독으로 시도합니다.", e);
                // 시도 2: 카메라가 없으면 마이크만 요청
                webcamStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            }

            // 마이크 볼륨 시각화 미리 시작
            if (webcamStream) {
                startAudioVisualizer(webcamStream);
                // 실시간 표정 분석 루프 시작
                if (isModelsLoaded) startFaceAnalysis();
            }
        } catch (err) {
            console.error("Recording error:", err);
            chatStatus.textContent = "권한이 없어 카메라나 마이크를 사용할 수 없습니다.";
        }
    }

    // ==========================================
    // 실시간 표정 및 구도 분석 로직
    // ==========================================
    async function startFaceAnalysis() {
        if (!webcamVideo || !isModelsLoaded) return;

        const syncRateText = document.getElementById('sync-rate-text');
        const syncRateBar = document.getElementById('sync-rate-bar');
        const syncFeedback = document.getElementById('sync-feedback');
        
        const warmthScoreEl = document.getElementById('warmth-score');
        const warmthBar = document.getElementById('warmth-bar');
        const focusScoreEl = document.getElementById('focus-score');
        const focusBar = document.getElementById('focus-bar');
        const energyScoreEl = document.getElementById('energy-score');
        const energyBar = document.getElementById('energy-bar');

        const runAnalysis = async () => {
            if (!webcamStream) return;

            const detections = await faceapi.detectSingleFace(
                webcamVideo,
                new faceapi.TinyFaceDetectorOptions()
            ).withFaceLandmarks().withFaceExpressions();

            if (detections) {
                // 1. 구도 분석 (상반신/얼굴 위치)
                const box = detections.detection.box;
                const videoWidth = webcamVideo.videoWidth || 640;
                const videoHeight = webcamVideo.videoHeight || 480;
                
                // 가이드라인(중앙)과의 거리 및 크기 계산
                const faceCenterX = box.x + box.width / 2;
                const faceCenterY = box.y + box.height / 2;
                const distFromCenter = Math.sqrt(
                    Math.pow((faceCenterX - videoWidth / 2) / videoWidth, 2) + 
                    Math.pow((faceCenterY - videoHeight / 3) / videoHeight, 2)
                );
                
                const sizeRatio = box.width / videoWidth;
                let syncScore = Math.max(0, 100 - (distFromCenter * 150));
                if (sizeRatio < 0.1) syncScore *= 0.5; // 너무 멀리 있음
                if (sizeRatio > 0.5) syncScore *= 0.8; // 너무 가까움
                
                const finalSync = Math.min(100, Math.round(syncScore));
                if (syncRateBar) syncRateBar.style.width = finalSync + '%';
                if (syncRateText) syncRateText.textContent = finalSync + '%';
                
                if (syncFeedback) {
                    if (finalSync >= 90) {
                        syncFeedback.textContent = "✓ 상반신 및 얼굴 구도가 아주 좋습니다!";
                        syncFeedback.style.color = "#34d399";
                    } else if (finalSync >= 70) {
                        syncFeedback.textContent = "구도가 양호합니다. 조금 더 중앙으로 와주세요.";
                        syncFeedback.style.color = "#fbbf24";
                    } else {
                        syncFeedback.textContent = "⚠️ 카메라 중앙에 상반신이 오도록 맞춰주세요.";
                        syncFeedback.style.color = "#ef4444";
                    }
                }

                // 2. 항목별 표정 분석 (AI Logic 반영)
                const expr = detections.expressions;
                const landmarks = detections.landmarks;
                
                // ① 친밀 공감 (Warmth): 행복도 + 입꼬리
                const mouth = landmarks.getMouth();
                const leftMouth = mouth[0];
                const rightMouth = mouth[6];
                const topMouth = mouth[3];
                const bottomMouth = mouth[9];
                const mouthWidth = Math.sqrt(Math.pow(leftMouth.x - rightMouth.x, 2) + Math.pow(leftMouth.y - rightMouth.y, 2));
                const mouthUpward = ((leftMouth.y + rightMouth.y) / 2) - bottomMouth.y;
                
                let warmthVal = (expr.happy * 70) + (Math.max(0, mouthUpward + 10) * 2);
                warmthVal = Math.min(100, Math.max(0, warmthVal));
                
                // smoothing
                expressionHistory.warmth.push(warmthVal);
                if (expressionHistory.warmth.length > 10) expressionHistory.warmth.shift();
                const avgWarmth = Math.round(expressionHistory.warmth.reduce((a, b) => a + b, 0) / expressionHistory.warmth.length);
                
                if (warmthScoreEl) warmthScoreEl.textContent = avgWarmth + '%';
                if (warmthBar) warmthBar.style.width = avgWarmth + '%';

                // ② 신뢰 몰입 (Focus): 중립도 + 미간 거리
                const leftEye = landmarks.getLeftEye();
                const rightEye = landmarks.getRightEye();
                const leftEyebrow = landmarks.getLeftEyeBrow();
                const rightEyebrow = landmarks.getRightEyeBrow();
                
                // 미간 집중도 (눈썹 사이 거리 변화)
                const browDist = Math.abs(leftEyebrow[4].x - rightEyebrow[0].x);
                let focusVal = (expr.neutral * 60) + (expr.surprised * 20);
                if (browDist < (mouthWidth * 0.45)) focusVal += 30; // 미간 찌푸림(집중)
                focusVal = Math.min(100, Math.max(0, focusVal));
                
                // smoothing
                expressionHistory.focus.push(focusVal);
                if (expressionHistory.focus.length > 10) expressionHistory.focus.shift();
                const avgFocus = Math.round(expressionHistory.focus.reduce((a, b) => a + b, 0) / expressionHistory.focus.length);

                if (focusScoreEl) focusScoreEl.textContent = avgFocus + '%';
                if (focusBar) focusBar.style.width = avgFocus + '%';

                // ③ 열정 활력 (Energy): 표정 변화 빈도 + 움직임
                let movement = 0;
                if (lastLandmarks) {
                    const currentPos = landmarks.positions;
                    const lastPos = lastLandmarks.positions;
                    for (let i = 0; i < currentPos.length; i += 10) { // 샘플링
                        movement += Math.sqrt(Math.pow(currentPos[i].x - lastPos[i].x, 2) + Math.pow(currentPos[i].y - lastPos[i].y, 2));
                    }
                }
                lastLandmarks = landmarks;
                
                let energyVal = (movement * 5) + (expr.surprised * 40) + ((1 - expr.neutral) * 20); 
                energyVal = Math.min(100, Math.max(0, energyVal));
                
                // smoothing
                expressionHistory.energy.push(energyVal);
                if (expressionHistory.energy.length > 15) expressionHistory.energy.shift();
                const avgEnergy = Math.round(expressionHistory.energy.reduce((a, b) => a + b, 0) / expressionHistory.energy.length);

                if (energyScoreEl) energyScoreEl.textContent = avgEnergy + '%';
                if (energyBar) energyBar.style.width = avgEnergy + '%';

            } else {
                // 얼굴 미검출 시 점진적 하락
                if (syncRateBar) syncRateBar.style.width = '0%';
                if (syncRateText) syncRateText.textContent = '0%';
                if (syncFeedback) syncFeedback.textContent = "얼굴을 찾을 수 없습니다.";
            }

            if (isSessionRunning || !isModelsLoaded) {
                requestAnimationFrame(runAnalysis);
            }
        };

        runAnalysis();
    }

    // Stop Coaching Session
    function stopCoaching() {
        if(webcamStream) {
            webcamStream.getTracks().forEach(track => track.stop());
            webcamStream = null;
        }
        if(speechRecognition) {
            speechRecognition.stop();
            isRecording = false;
        }
        if (typeof currentAudio !== 'undefined' && currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }
        if(micBtn) micBtn.classList.remove('recording');
        if(micText) micText.textContent = "코칭 시작";
        if(geminiAvatar) geminiAvatar.classList.remove('speaking');
    }

    // Speech Recognition Setup (Web Speech API)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let speechRecognition = null;
    let isRecording = false;
    let isTTSPlaying = false;
    let isFetchingGemini = false;

    if (SpeechRecognition) {
        speechRecognition = new SpeechRecognition();
        speechRecognition.lang = 'ko-KR';
        speechRecognition.interimResults = true;
        speechRecognition.continuous = true; // 연속 인식 모드 활성화 (끊김 현상 방지)
        speechRecognition.maxAlternatives = 1;

        speechRecognition.onstart = () => {
            isRecording = true;
            if(chatStatus) chatStatus.textContent = "강사님의 목소리를 듣고 있습니다...";
            if(instructorText) instructorText.classList.remove('active');
            if(geminiText) geminiText.classList.remove('active');
        };

        speechRecognition.onresult = async (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }
            
            // 화면에 실시간으로 내가 하는 말을 뿌려줌 (답답함 해소)
            if(instructorText) {
                instructorText.textContent = finalTranscript || interimTranscript;
                instructorText.classList.add('active');
            }

            // 문장이 완전히 끝났을 때만 서버로 전송
            if (finalTranscript.trim().length > 0) {
                if(chatStatus) chatStatus.textContent = "제미나이가 생각 중입니다...";
                
                isFetchingGemini = true;
                speechRecognition.stop(); // 두 번 요청 방지용 잠시 멈춤
                
                await askGemini(finalTranscript);
            }
        };

        speechRecognition.onerror = (event) => {
            isRecording = false;
            // 에러가 나더라도 세션중이면 계속 듣기모드로 전환
            if(event.error !== 'no-speech' && event.error !== 'aborted') {
                console.error("Speech Recognition Error:", event.error);
            }
        };

        speechRecognition.onend = () => {
            console.log("🎤 마이크 인식 중단됨 (onend)");
            isRecording = false;
            // 세션 진행 중이고, 제미나이가 말하는 중이 아니며, 서버 로딩중이 아니고, 일시정지가 아닐 때만 다시 마이크 열기!
            if(isSessionRunning && !isTTSPlaying && !isFetchingGemini && !isPaused) {
                restartMic();
            }
        };
    } else {
        console.warn("현재 브라우저는 음성 인식을 지원하지 않습니다.");
        if(chatStatus) chatStatus.textContent = "음성 인식을 지원하지 않는 브라우저입니다.";
    }

    function restartMic() {
        if (!speechRecognition || !isSessionRunning || isPaused || isTTSPlaying || isFetchingGemini) return;
        
        try {
            console.log("🔄 마이크 재시작 시도...");
            speechRecognition.start();
        } catch(e) {
            // 이미 실행 중인 경우 등은 무시
        }
    }

    // Request Gemini API through backend
    async function askGemini(userText) {
        const grade = document.getElementById('persona-grade')?.value || '';
        const level = document.getElementById('persona-level')?.value || '';
        const period = document.getElementById('persona-period')?.value || '';
        
        // Google TTS 파라미터 (프론트 UI값 읽기)
        const speedSlider = document.getElementById('tts-speed-slider');
        const voiceSelect = document.getElementById('tts-voice-select');
        const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;
        const voice = voiceSelect ? voiceSelect.value : 'ko-KR-Neural2-A';

        try {
            const response = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    message: userText,
                    grade: grade,
                    level: level,
                    period: period,
                    speed: speed,
                    voice: voice,
                    instructorName: localStorage.getItem('instructorName') || '선생님',
                    branchName: localStorage.getItem('branchName') || '지점'
                })
            });
            const data = await response.json();
            
            if(data.success) {
                // Show Gemini text
                geminiText.textContent = data.reply;
                geminiText.classList.add('active');
                chatStatus.textContent = "제미나이가 답변하고 있습니다...";
                
                // Play Google Cloud TTS Audio or Fallback to Browser TTS
                isFetchingGemini = false; // 답변 수신 완료
                if (data.audioContent) {
                    playGoogleTTS(data.audioContent);
                } else {
                    console.warn("오디오 데이터가 수신되지 않아 브라우저 내장 TTS(어린아이 톤)로 대체합니다.");
                    playBrowserTTS(data.reply);
                }
            } else {
                chatStatus.textContent = `서버 통신 실패 (상태: ${response.status})`;
                console.error("Server Response Error:", data);
            }
        } catch (err) {
            console.error("Gemini Request Error:", err);
            chatStatus.textContent = `서버 오류: ${err.message || "연결 안됨"}`;
        } finally {
            // 어떤 상황에서도 로딩 상태 해제
            isFetchingGemini = false;
            isRecording = false; 
            
            // 만약 TTS가 플레이되지 않는 경우(에러 등)에는 즉시 마이크 다시 열기 시도
            setTimeout(() => {
                restartMic();
            }, 600);
        }
    }

    // Google Cloud TTS Setup
    let currentAudio = null;

    // Google TTS base64 Audio Playback
    function playGoogleTTS(base64Audio) {
        console.log("🔊 Google TTS 재생 시도...");
        try {
            if (currentAudio) {
                currentAudio.pause();
                currentAudio = null;
            }
            
            const audioSrc = "data:audio/mp3;base64," + base64Audio;
            currentAudio = new Audio(audioSrc);
            isTTSPlaying = true;
            
            currentAudio.onplay = () => {
                console.log("▶️ 오디오 재생 시작됨");
                isTTSPlaying = true;
                if (speechRecognition && isRecording) {
                    speechRecognition.abort();
                }
                if(geminiAvatar) geminiAvatar.classList.add('speaking');
            };
            
            currentAudio.onended = () => {
                console.log("⏹️ 오디오 재생 종료됨");
                isTTSPlaying = false;
                if(geminiAvatar) geminiAvatar.classList.remove('speaking');
                if(chatStatus) chatStatus.textContent = "강사님의 목소리를 듣고 있습니다...";
                
                restartMic();
            };

            currentAudio.onerror = (e) => {
                console.error("❌ 오디오 객체 에러:", e);
                isTTSPlaying = false;
            };
            
            const playPromise = currentAudio.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log("✅ 재생 성공");
                }).catch(error => {
                    console.error("❌ 재생 실패 (브라우저 차단 등):", error);
                    isTTSPlaying = false;
                    // 브라우저 차단 시 내장 TTS로 시도해볼 수 있음 (선택사항)
                });
            }
        } catch (e) {
            console.error("Audio Setup Error:", e);
            isTTSPlaying = false;
        }
    }

    // 목소리 테스트 버튼 이벤트 추가
    const testTtsBtn = document.getElementById('test-tts-btn');
    if (testTtsBtn) {
        testTtsBtn.addEventListener('click', async () => {
            const originalText = testTtsBtn.textContent;
            testTtsBtn.textContent = "확인중...";
            testTtsBtn.disabled = true;

            const voice = document.getElementById('tts-voice-select')?.value || 'ko-KR-Standard-A';
            const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1.0');

            try {
                const res = await fetch(`${API_BASE}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        message: "반갑습니당. 전 에이닷 학생이에용.", 
                        grade: "고1", level: "1", period: "1", 
                        speed: speed, voice: voice 
                    })
                });
                const data = await res.json();
                if (data.audioContent) {
                    playGoogleTTS(data.audioContent);
                } else {
                    alert("서버에서 오디오 데이터를 받지 못했습니다. API 키나 권한을 확인해 주세요.");
                }
            } catch (err) {
                console.error(err);
                alert("통신 오류가 발생했습니다.");
            } finally {
                testTtsBtn.textContent = originalText;
                testTtsBtn.disabled = false;
            }
        });
    }
    
    // 브라우저 내장 TTS (구글 API 차단 시 예비책)
    function playBrowserTTS(text) {
        if ('speechSynthesis' in window) {
            // 재생 중인 다른 소리가 있다면 취소
            window.speechSynthesis.cancel();
            
            isTTSPlaying = true;
            if (speechRecognition && isRecording) {
                speechRecognition.abort();
            }
            if(geminiAvatar) geminiAvatar.classList.add('speaking');
            
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'ko-KR';
            utterance.pitch = 1.5; // 피치를 높여 10대 여자아이 목소리처럼 변조
            utterance.rate = 1.05; // 살짝 빠르게
            
            // TTS 음속 조절 (슬라이더 반영)
            const speedSlider = document.getElementById('tts-speed-slider');
            if(speedSlider) {
                utterance.rate = parseFloat(speedSlider.value) * 1.05;
            }

            utterance.onend = () => {
                isTTSPlaying = false;
                if(geminiAvatar) geminiAvatar.classList.remove('speaking');
                if(chatStatus) chatStatus.textContent = "강사님의 목소리를 듣고 있습니다...";
                
                if(isSessionRunning && !isRecording && speechRecognition && !isPaused) {
                    try { speechRecognition.start(); } catch(e){}
                }
            };
            
            utterance.onerror = (e) => {
                console.error("Browser TTS Error", e);
                isTTSPlaying = false;
                if(isSessionRunning && !isRecording && speechRecognition && !isPaused) {
                    try { speechRecognition.start(); } catch(e){}
                }
            };
            
            window.speechSynthesis.speak(utterance);
        } else {
            chatStatus.textContent = "대기 중...";
            if(isSessionRunning && !isRecording && speechRecognition) {
                try { speechRecognition.start(); } catch(e){}
            }
        }
    }

    // Session Timer and MediaRecorder Logic
    const startBtn = document.getElementById('start-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const endBtn = document.getElementById('end-btn');
    const sessionTimerDisplay = document.getElementById('session-timer');
    const recIndicator = document.getElementById('rec-indicator');
    let isPaused = false;
    let currentSessionType = '연습용'; // 세션 시작 시 종류 저장용
    
    // TTS Speed Slider Event
    const ttsSpeedSlider = document.getElementById('tts-speed-slider');
    const ttsSpeedText = document.getElementById('tts-speed-text');

    // Slider text updating
    if (ttsSpeedSlider && ttsSpeedText) {
        ttsSpeedSlider.addEventListener('input', (e) => {
            ttsSpeedText.textContent = Number(e.target.value).toFixed(1) + "배속";
        });
    }

    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (isSessionRunning) return; // 이미 실행 중이면 무시

            // 페르소나 선택 유효성 검사
            const grade = document.getElementById('persona-grade')?.value;
            const level = document.getElementById('persona-level')?.value;
            const period = document.getElementById('persona-period')?.value;

            if (!grade || !level || !period) {
                alert("코칭을 시작하기 전에 학년, 영어실력, 재원기간을 모두 선택해 주세요!");
                return;
            }

            // 최초 시작
            isSessionRunning = true;
            isPaused = false;
            timeLeft = 15 * 60; // 15 mins
            currentSessionType = document.getElementById('persona-type')?.value || '연습용';
            console.log("🚀 세션 시작됨. 타입:", currentSessionType);
            
            // 드롭박스 프리징 (실행 시 변경 불가)
            const selectors = ['persona-type', 'persona-grade', 'persona-level', 'persona-period'];
            selectors.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.disabled = true;
                    el.style.opacity = "0.6";
                    el.style.cursor = "not-allowed";
                }
            });
            
            // 실행 버튼 비활성화
            startBtn.disabled = true;
            startBtn.style.opacity = "0.5";
            startBtn.style.cursor = "not-allowed";

            // 코칭 목적에 따른 일시정지 버튼 활성/비활성 처리
            const isPractice = document.getElementById('persona-type')?.value === '연습용';
            if (pauseBtn) {
                if (isPractice) {
                    pauseBtn.disabled = false;
                    pauseBtn.style.opacity = "1";
                    pauseBtn.style.cursor = "pointer";
                    pauseBtn.textContent = "⏸ 일시종료";
                } else {
                    pauseBtn.disabled = true;
                    pauseBtn.style.opacity = "0.3";
                    pauseBtn.style.cursor = "not-allowed";
                    pauseBtn.textContent = "⏸ 정지불가";
                }
            }
            
            if (endBtn) {
                endBtn.disabled = false;
                endBtn.style.cursor = "pointer";
                endBtn.style.color = "white";
                endBtn.style.background = "#ef4444"; 
            }

            if(recIndicator) recIndicator.style.display = "flex";

            updateTimerDisplay();

            if (!webcamStream) {
                alert("마이크와 카메라 권한을 허용해야 세션 진행이 가능합니다. (새로고침 요망)");
                endSession(true);
                return;
            }

            try {
                recordedChunks = [];
                mediaRecorder = new MediaRecorder(webcamStream, { mimeType: 'video/webm' });
                
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) recordedChunks.push(e.data);
                };
                
                mediaRecorder.onstop = async () => {
                    const blob = new Blob(recordedChunks, { type: 'video/webm' });
                    uploadVideo(blob);
                };

                mediaRecorder.start(1000); // 1초 단위로 데이터 청크 수집
            } catch (err) {
                console.error("MediaRecorder Error:", err);
                endSession(true);
                return;
            }

            sessionTimer = setInterval(() => {
                timeLeft--;
                updateTimerDisplay();

                if (timeLeft <= 0) {
                    endSession(false);
                }
            }, 1000);
            
            if(chatStatus) chatStatus.textContent = "코칭 세션이 시작되었습니다. 학생 페르소나와 대화를 시작하세요!";
            
            if (speechRecognition && !isRecording) {
                try { 
                    const transcriptBox = document.querySelector('.chat-transcript');
                    if(transcriptBox) transcriptBox.style.display = 'block';
                    speechRecognition.start(); 
                } catch(e){}
            }
        });
    }

    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            if (!isSessionRunning) return;
            
            const isPractice = document.getElementById('persona-type')?.value === '연습용';
            if (!isPractice) return; // 연습용이 아니면 작동 안함

            if (isPaused) {
                // 멈춤 상태에서 재개(Resume)
                isPaused = false;
                pauseBtn.textContent = "⏸ 일시종료";
                pauseBtn.style.background = "#f59e0b";
                
                if (mediaRecorder && mediaRecorder.state === 'paused') {
                    mediaRecorder.resume();
                }
                if (recIndicator) recIndicator.style.display = "flex";
                
                sessionTimer = setInterval(() => {
                    timeLeft--;
                    updateTimerDisplay();

                    if (timeLeft <= 0) {
                        endSession(false);
                    }
                }, 1000);
                
                if (speechRecognition) {
                    try { speechRecognition.abort(); } catch(e){}
                }
                
                setTimeout(() => {
                    restartMic();
                }, 300);

                if(chatStatus) chatStatus.textContent = "코칭이 재개되었습니다.";
            } else {
                // 실행 중 상태에서 일시멈춤(Pause)
                isPaused = true;
                pauseBtn.textContent = "▶ 계속하기";
                pauseBtn.style.background = "var(--primary-color)";
                
                clearInterval(sessionTimer);
                
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.pause();
                }
                if (recIndicator) recIndicator.style.display = "none";
                
                if (speechRecognition) {
                    try { speechRecognition.stop(); } catch(e){} 
                }
                if(chatStatus) chatStatus.textContent = "코칭이 일시정지 되었습니다.";
            }
        });
    }

    if (endBtn) {
        endBtn.addEventListener('click', () => {
            if (isSessionRunning) {
                if (confirm("코칭을 종료하시겠습니까? 종료 시 자동으로 서버에 저장됩니다.")) {
                    endSession(false);
                }
            }
        });
    }

    function updateTimerDisplay() {
        if (!sessionTimerDisplay) return;
        const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
        const s = (timeLeft % 60).toString().padStart(2, '0');
        sessionTimerDisplay.textContent = `${m}:${s}`;
    }

    function endSession(isError) {
        isSessionRunning = false;
        isPaused = false;
        clearInterval(sessionTimer);
        
        // --- 대화 음성 강제 종료 (TTS 취소) ---
        if (typeof window.speechSynthesis !== 'undefined') {
            window.speechSynthesis.cancel();
        }
        if (typeof geminiAvatar !== 'undefined' && geminiAvatar) geminiAvatar.classList.remove('speaking');
        // ----------------------------------------
        
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.style.opacity = "1";
            startBtn.style.cursor = "pointer";
            startBtn.textContent = "▶ 실행";
        }
        
        if (pauseBtn) {
            pauseBtn.disabled = true;
            pauseBtn.style.opacity = "0.5";
            pauseBtn.style.cursor = "not-allowed";
            pauseBtn.textContent = "⏸ 일시종료";
            pauseBtn.style.background = "#f59e0b";
        }

        if (endBtn) {
            endBtn.disabled = true;
            endBtn.style.cursor = "not-allowed";
            endBtn.style.color = "rgba(255,255,255,0.4)";
            endBtn.style.background = "rgba(255,255,255,0.1)";
        }
        
        if (recIndicator) recIndicator.style.display = "none";

        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }

        if (speechRecognition && isRecording) {
            speechRecognition.abort();
        }

        if(!isError) alert("15분 코칭 세션이 종료되었습니다. 영상을 기록 보관함에 저장합니다.");

        // 드롭박스 프리징 해제
        const selectors = ['persona-type', 'persona-grade', 'persona-level', 'persona-period'];
        selectors.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = false;
                el.style.opacity = "1";
                el.style.cursor = "pointer";
            }
        });
    }

    async function uploadVideo(blob) {
        const branch = localStorage.getItem('branchName') || 'UnknownBranch';
        const instructor = localStorage.getItem('instructorName') || 'UnknownInstructor';
        const crmId = localStorage.getItem('crmId') || 'UnknownID';
        
        const dateObj = new Date();
        const dateStr = dateObj.getFullYear() + String(dateObj.getMonth() + 1).padStart(2, '0') + String(dateObj.getDate()).padStart(2, '0');
        
        // 파일명 맨 앞에 [연습용] 또는 [본사피드백용] 추가
        const filename = `[${currentSessionType}]_${branch}_${instructor}_${crmId}_${dateStr}.webm`;
        console.log("📂 업로드할 파일명:", filename);
        
        const formData = new FormData();
        formData.append('video', blob, filename);
        formData.append('filename', filename);

        chatStatus.textContent = "녹화 영상을 구글 드라이브에 업로드 중입니다. 잠시만 기다려주세요...";

        try {
            const response = await fetch(`${API_BASE}/api/upload_video`, {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (data.success) {
                chatStatus.textContent = "녹화 영상이 서버에 성공적으로 업로드되었습니다!";
            } else {
                chatStatus.textContent = "드라이브 업로드 실패: " + data.message;
            }
        } catch (error) {
            console.error(error);
            chatStatus.textContent = "서버 통신 오류: 영상 업로드 중 문제가 발생했습니다.";
        }
    }
    
    // Audio Visualizer Functions
    let audioContext = null;
    let analyser = null;
    let microphoneNode = null;
    let visualizerAnimId = null;

    function startAudioVisualizer(stream) {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 64; 
        
        microphoneNode = audioContext.createMediaStreamSource(stream);
        microphoneNode.connect(analyser);
        
        const audioBars = document.querySelectorAll('.audio-bar');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function drawVisualizer() {
            visualizerAnimId = requestAnimationFrame(drawVisualizer);
            analyser.getByteFrequencyData(dataArray);
            
            const step = Math.floor(bufferLength / 9) || 1;
            
            for (let i = 0; i < audioBars.length; i++) {
                let sum = 0;
                for(let j=0; j<step; j++){
                    sum += dataArray[i * step + j] || 0;
                }
                let avg = sum / step;
                
                let percent = (avg / 255) * 100;
                percent = Math.max(5, percent); // 최소 5% 높이 유지
                
                audioBars[i].style.height = `${percent}%`;
                
                if (percent > 70) {
                    audioBars[i].style.background = '#ef4444'; // Red
                } else if (percent > 40) {
                    audioBars[i].style.background = '#eab308'; // Yellow
                } else {
                    audioBars[i].style.background = '#0ea5e9'; // Blue
                }
            }
        }
        
        drawVisualizer();
    }
    
    function stopAudioVisualizer() {
        if (visualizerAnimId) {
            cancelAnimationFrame(visualizerAnimId);
        }
        if (microphoneNode) {
            microphoneNode.disconnect();
            microphoneNode = null;
        }
        const audioBars = document.querySelectorAll('.audio-bar');
        audioBars.forEach(bar => {
            bar.style.height = '5%';
            bar.style.background = '#0ea5e9';
        });
    }

});
