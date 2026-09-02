# Beads LUCKY DRAW

An event raffle application that allows two or more devices to share and update prize inventory in real time through the same server.
It is designed to resemble a ball-drawing raffle machine.

## Railway 배포

1. GitHub 저장소를 Railway 프로젝트에 연결합니다.
2. 서비스 Variables에 ADMIN_PASSWORD를 설정합니다.
3. 영구 볼륨을 /data 경로에 마운트합니다.
4. Variables에 DATA_FILE=/data/data.json을 설정합니다.
5. Healthcheck 경로를 /health로 설정합니다.
6. Public Networking에서 roulette.kucisc.kr을 Custom Domain으로 추가합니다.

관리자 페이지의 사용자 이름은 admin이며 비밀번호는 Railway의 ADMIN_PASSWORD 값입니다.