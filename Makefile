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
	@podman info >/dev/null 2>&1 || podman machine start
	podman-compose up --force-recreate
