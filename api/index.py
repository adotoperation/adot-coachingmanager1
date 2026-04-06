from flask import Flask, send_from_directory, request, jsonify
import urllib.request
import csv
import io
import os
import re
import requests
import pandas as pd
import google.generativeai as genai
import PIL.Image
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseUpload
from dotenv import load_dotenv
from flask_cors import CORS

# 환경 변수 로드 및 확인
load_dotenv()

# ==========================================
# [설정 및 상수 정의 - 환경 변수 사용]
# ==========================================
SHEET_CSV_URL = os.getenv("SHEET_CSV_URL")
XLSX_URL = os.getenv("XLSX_URL")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GOOGLE_TTS_API_KEY = os.getenv("GOOGLE_TTS_API_KEY")
DRIVE_FOLDER_ID = os.getenv("DRIVE_FOLDER_ID")

# Vercel 환경에서는 /tmp 폴더만 쓰기 권한이 있음
IS_VERCEL = "VERCEL" in os.environ
TOKEN_FILE = "/tmp/token.json" if IS_VERCEL else "token.json"

# 로딩 확인 로그
configs = {
    "SHEET_CSV_URL": SHEET_CSV_URL,
    "XLSX_URL": XLSX_URL,
    "GEMINI_API_KEY": GEMINI_API_KEY,
    "GOOGLE_TTS_API_KEY": GOOGLE_TTS_API_KEY,
    "DRIVE_FOLDER_ID": DRIVE_FOLDER_ID,
    "DRIVE_TOKEN_JSON": "✅ OK" if os.getenv("DRIVE_TOKEN_JSON") else "❌ 누락 (MISSING)"
}

print("--- [환경 변수 로딩 상태 확인] ---")
missing_vars = []
for k, v in configs.items():
    if not v:
        print(f"{k}: ❌ 누락 (MISSING)")
        missing_vars.append(k)
    else:
        print(f"{k}: ✅ OK")

if missing_vars:
    print(f"\n🚨 [치명적 오류] 다음 환경 변수가 설정되지 않았습니다: {', '.join(missing_vars)}")
    print("👉 Railway 대시보드의 [Variables] 탭에서 위 변수들을 반드시 추가해 주세요!\n")
print("---------------------------------")

# Gemini 초기화
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

app = Flask(__name__, static_folder='.')
CORS(app) # 프론트엔드(Vercel)와의 통신 허용

# ==========================================
# [구글 드라이브 서비스 초기화]
# ==========================================
def get_drive_service():
    try:
        # Vercel 환경에서 환경 변수로부터 token.json 복원 로직 추가
        token_env = os.getenv("DRIVE_TOKEN_JSON")
        if token_env and not os.path.exists(TOKEN_FILE):
             with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
                 f.write(token_env)
             print("✅ 환경 변수에서 token.json 복원 완료")

        if os.path.exists(TOKEN_FILE):
            from google.auth.transport.requests import Request
            creds = Credentials.from_authorized_user_file(TOKEN_FILE, ['https://www.googleapis.com/auth/drive.file'])
            
            # 토큰이 만료되었거나 없을 경우 갱신 시도
            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    print("🔄 구글 드라이브 토큰이 만료되어 갱신을 시도합니다...")
                    creds.refresh(Request())
                    # 갱신된 토큰을 파일에 다시 저장 (현재 인스턴스 반영)
                    with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
                        f.write(creds.to_json())
                    print("✅ 구글 드라이브 토큰 갱신 및 복원 완료")
            
            return build('drive', 'v3', credentials=creds)
        else:
            print("⚠️ 알림: token.json 파일을 찾을 수 없습니다. 구글 드라이브 업로드가 제한될 수 있습니다.")
            return None
    except Exception as e:
        print(f"❌ 드라이브 서비스 초기화 에러: {e}")
        return None

# ==========================================
# [로그인 API 및 헬스체크]
# ==========================================
@app.route('/api/health')
def health_check():
    return jsonify({
        "status": "online",
        "env": {
            "SHEET_CSV": "OK" if SHEET_CSV_URL else "MISSING",
            "GEMINI": "OK" if GEMINI_API_KEY else "MISSING",
            "TOKEN": "OK" if os.environ.get("DRIVE_TOKEN_JSON") else "MISSING"
        },
        "is_vercel": IS_VERCEL
    })

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    return send_from_directory('.', path)

# ==========================================
# [로그인 API]
# ==========================================
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    branch = data.get('branch')
    crm_id = data.get('crmId')
    password = data.get('password')

    try:
        if not SHEET_CSV_URL:
            return jsonify({"success": False, "message": "🚨 [서버 설정 오류] SHEET_CSV_URL이 Railway에 설정되지 않았습니다."}), 500
            
        req = urllib.request.Request(SHEET_CSV_URL)
        with urllib.request.urlopen(req) as response:
            decoded_content = response.read().decode('utf-8')
            
        csv_reader = list(csv.reader(io.StringIO(decoded_content)))
        print(f"📊 [데이터 진단] 시트에서 총 {len(csv_reader)}개의 행을 읽어왔습니다.")
        if len(csv_reader) > 1:
            sample_row = csv_reader[1]
            print(f"📝 [데이터 샘플] 첫 번째 데이터: 지점={sample_row[0][:2]}**, ID={sample_row[1][:2]}**")
        
        for row in csv_reader[1:]: # Skip header
            if len(row) >= 4:
                # 공백 제거 및 비교
                r_branch = row[0].strip()
                r_id = row[1].strip()
                r_pw = row[2].strip()
                
                if r_branch == branch.strip() and r_id == crm_id.strip() and r_pw == password.strip():
                    return jsonify({"success": True, "message": "로그인 성공!", "instructorName": row[3].strip()})
                    
        return jsonify({"success": False, "message": "지점명, 아이디 또는 비밀번호가 일치하지 않습니다. (입력값 확인 요망)"})
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"❌ 로그인 에러 상세:\n{error_details}")
        return jsonify({"success": False, "message": f"서버 오류: {str(e)}", "details": error_details}), 500

# ==========================================
# [페르소나 목록 조회]
# ==========================================
@app.route('/api/personas', methods=['GET'])
def get_personas():
    try:
        if not XLSX_URL:
            return jsonify({"success": False, "message": "🚨 [서버 설정 오류] XLSX_URL이 Railway에 설정되지 않았습니다."}), 500
        
        print(f"📊 [페르소나 진단] XLSX_URL에서 데이터를 읽어오는 중...")
        df = pd.read_excel(XLSX_URL, sheet_name='페르소나')
        
        grades = [str(x) for x in df.iloc[:, 0].dropna().unique().tolist()]
        levels = [str(x) for x in df.iloc[:, 1].dropna().unique().tolist()]
        periods = [str(x) for x in df.iloc[:, 2].dropna().unique().tolist()]
        
        print(f"✅ [페르소나 진단] 성공! (학년:{len(grades)}개, 레벨:{len(levels)}개 확인)")
        
        return jsonify({
            "success": True, 
            "grades": grades,
            "levels": levels,
            "periods": periods
        })
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"❌ [페르소나 에러] 데이터를 불러올 수 없습니다: {e}")
        
        # 추가 진단: 엑셀 파일은 읽히는지, 시트 이름은 무엇인지 확인
        try:
            xl = pd.ExcelFile(XLSX_URL)
            print(f"📝 [추가 진단] 엑셀 파일은 정상입니다. 존재하는 시트 목록: {xl.sheet_names}")
            diag_msg = f"시트 목록: {xl.sheet_names} (현재 '페르소나' 가 필요합니다)"
        except:
            print("❌ [추가 진단] 서버가 엑셀 파일 자체에 접근할 수 없습니다. XLSX_URL 주소를 확인해 주세요.")
            diag_msg = "엑셀 파일 접근 실패. 주소가 정확한 'Export' 주소인지 확인해 주세요."
            
        return jsonify({"success": False, "error": str(e), "message": diag_msg, "details": error_details})

# ==========================================
# [과거 코칭 이력 조회]
# ==========================================
@app.route('/api/history', methods=['GET'])
def get_history():
    crm_id = request.args.get('crmId')
    if not crm_id:
        return jsonify({"success": False, "message": "CRM ID가 필요합니다."})
        
    try:
        df = pd.read_excel(XLSX_URL, sheet_name='RDB')
        # 변경된 열 구조: D열(Index 3)이 아이디, E열(Index 4)이 날짜, F열(Index 5)이 영상 링크
        filtered_df = df[df.iloc[:, 3].astype(str).str.strip() == crm_id]
        
        history_list = []
        for _, row in filtered_df.iterrows():
            history_list.append({
                "date": str(row.iloc[4]),
                "videoUrl": str(row.iloc[5]),
                "score": "" # 필요 시 추후 추가
            })
        history_list.reverse() # 최신순
        return jsonify({"success": True, "history": history_list})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

# ==========================================
# [제미나이 채팅 및 TTS 연동]
# ==========================================
@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.json
    user_message = data.get('message', '')
    persona_grade = data.get('grade', '')
    persona_level = data.get('level', '')
    persona_period = data.get('period', '')
    instructor_name = data.get('instructorName', '선생님')
    branch_name = data.get('branchName', '지점')
    
    print(f"[{branch_name} {instructor_name} 강사 음성 입력]: {user_message}")
    
    # 페르소나 D열 상세 프롬프트 로드
    persona_prompt = ""
    try:
        persona_df = pd.read_excel(XLSX_URL, sheet_name='페르소나')
        # 학년(A), 실력(B), 기간(C) 데이터 매칭 (공백 제거 및 문자열 변환 처리)
        match = persona_df[
            (persona_df.iloc[:, 0].astype(str).str.strip() == str(persona_grade).strip()) &
            (persona_df.iloc[:, 1].astype(str).str.strip() == str(persona_level).strip()) &
            (persona_df.iloc[:, 2].astype(str).str.strip() == str(persona_period).strip())
        ]
        if not match.empty:
            persona_prompt = str(match.iloc[0, 3]) # D열 (Index 3)
            print(f"✅ 페르소나 D열 프롬프트 적용 완료: {persona_prompt[:30]}...")
    except Exception as e:
        print(f"⚠️ 페르소나 프롬프트 로드 실패: {e}")

    try:
        if not GEMINI_API_KEY:
            return jsonify({"success": False, "message": "🚨 [서버 설정 오류] GEMINI_API_KEY가 없습니다!"}), 500
            
        model = genai.GenerativeModel('gemini-2.0-flash')
        
        # 시스템 프롬프트 구성 (D열 내용 반영)
        system_instruction = persona_prompt if persona_prompt and persona_prompt != 'nan' else "당신은 에이닷 코칭 시스템에서 선생님에게 상담을 받는 학생입니다."
        
        prompt = f"""
        당신은 에이닷 학생 페르소나입니다. 아래 설정을 바탕으로 대화하세요.
        
        [행동 지침]
        {system_instruction}
        
        [상황 정보]
        - 지점: {branch_name}
        - 선생님: {instructor_name}
        - 설정: {persona_grade}학년 / {persona_level} / {persona_period}
        
        [규칙]
        1. 10대 학생 말투로 짧게 1~2문장으로 대답하세요.
        2. 이모지나 특수 기호는 절대 사용하지 마세요. (TTS 보호)
        3. 한국어로만 답변하세요.
        
        선생님 말씀: "{user_message}"
        학생 답변:
        """
        
        print(f"🤖 [제미나이 호출] 프롬프트 준비 완료 (메시지: {user_message[:20]}...)")
        response = model.generate_content(prompt)
        
        if not response or not hasattr(response, 'text'):
             print("❌ [제미나이 에러] 응답 객체에 텍스트가 없습니다.")
             return jsonify({"success": False, "message": "제미나이 응답 형식이 올바르지 않습니다."}), 500
             
        raw_reply = response.text.replace("\n", " ").strip()
        print(f"✅ [제미나이 답변 성공]: {raw_reply[:30]}...")
        
        # 특수문자 제거
        reply = re.sub(r'[^가-힣a-zA-Z0-9\s\.\,\?\!]', '', raw_reply).strip()
        print(f"[제미나이 답변]: {reply}")

        # [구글 TTS 호출]
        audio_base64 = None
        try:
            tts_speed = float(data.get('speed', 1.0))
            tts_voice = data.get('voice', 'ko-KR-Standard-A')
            tts_url = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={GOOGLE_TTS_API_KEY}"
            
            payload = {
                "input": {"text": reply},
                "voice": {"languageCode": "ko-KR", "name": tts_voice},
                "audioConfig": {"audioEncoding": "MP3", "speakingRate": tts_speed, "pitch": 4.0}
            }
            
            r = requests.post(tts_url, json=payload)
            if r.status_code == 200:
                audio_base64 = r.json().get('audioContent')
            else:
                print(f"❌ TTS 에러 로그: 상태코드 {r.status_code}, 메시지 {r.text}")
        except Exception as tts_err:
            print(f"❌ TTS 통신 에러: {tts_err}")
            
        return jsonify({"success": True, "reply": reply, "audioContent": audio_base64})
    except Exception as e:
        error_msg = f"API 오류가 발생했습니다: {str(e)}"
        print(f"❌ 채팅 에러: {error_msg}")
        return jsonify({"success": True, "reply": error_msg, "audioContent": None})

# ==========================================
# [영상 로컬 및 구글 드라이브 업로드]
# ==========================================
@app.route('/api/upload_video', methods=['POST'])
def upload_video():
    if 'video' not in request.files:
        return jsonify({"success": False, "message": "비디오 데이터 전송 오류."}), 400
        
    file = request.files['video']
    filename = request.form.get('filename', 'coaching_session.webm')
    
    try:
        # 1. 구글 드라이브 업로드 (메모리 스트림 사용으로 로컬 저장 배제)
        drive_service = get_drive_service()
        if drive_service:
            file_metadata = {'name': filename, 'parents': [DRIVE_FOLDER_ID]}
            
            # 파일을 로컬에 저장하지 않고 메모리 스트림(BytesIO)을 통해 직접 업로드
            file_stream = io.BytesIO(file.read())
            media = MediaIoBaseUpload(file_stream, mimetype='video/webm', resumable=True)
            
            drive_file = drive_service.files().create(
                body=file_metadata, 
                media_body=media, 
                fields='id'
            ).execute()
            
            print(f"✅ 구글 드라이브 다이렉트 업로드 완료: {drive_file.get('id')}")
            return jsonify({"success": True, "message": "구글 드라이브 업로드 성공!"})
        else:
            return jsonify({"success": False, "message": "구글 드라이브 서비스 연결 실패."}), 500
            
    except Exception as e:
        error_msg = f"업로드 중 오류 발생: {str(e)}"
        print(f"❌ {error_msg}")
        return jsonify({"success": False, "message": error_msg}), 500

if __name__ == '__main__':
    # Railway 등 배포 환경에서는 PORT 환경 변수를 사용함
    port = int(os.environ.get("PORT", 5000))
    print(f"🚀 에이닷 코칭 시스템 실행 중! -> Port: {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
