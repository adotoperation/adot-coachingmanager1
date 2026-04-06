import requests, os
from dotenv import load_dotenv
load_dotenv()
key = os.getenv('GOOGLE_TTS_API_KEY')
utterance = '테스트입니다.'
url = f'https://texttospeech.googleapis.com/v1/text:synthesize?key={key}'
payload = {'input': {'text': utterance}, 'voice': {'languageCode': 'ko-KR', 'name': 'ko-KR-Standard-A'}, 'audioConfig': {'audioEncoding': 'MP3'}}
r = requests.post(url, json=payload)
print(f'Status: {r.status_code}')
print(f'Response: {r.text}')
