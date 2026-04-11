.PHONY: extension docker up

extension:
	cd extension && npm run build

docker:
	docker compose build

up:
	docker compose up
