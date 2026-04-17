.PHONY: extension docker up podman podman-up

extension:
	cd extension && npm run build

docker:
	docker compose build

up:
	docker compose up

podman:
	podman-compose build

podman-up:
	podman-compose up --force-recreate
