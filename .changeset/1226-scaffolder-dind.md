---
'@generacy-ai/generacy': patch
---

Enable Docker-in-Docker in the scaffolded compose for cluster-microservices clusters

`scaffoldDockerCompose` never emitted `privileged: true`, `ENABLE_DIND=true`, or
`DOCKER_CONTEXT=host`, so every cluster created by `generacy launch` (the npx/UI path)
or `generacy deploy` ran with DinD off — including `cluster-microservices` clusters,
where the image ships dockerd specifically to support it. `setup-docker-dind.sh` takes
a silent early return when `ENABLE_DIND` is unset, so the only symptom was a missing
`/var/run/docker.sock` with nothing in the logs.

The scaffolder now mirrors the reference `cluster-microservices` devcontainer compose.
`cluster-base` is deliberately unchanged: it ships no dockerd and reaches the host
daemon through a baked-in `DOCKER_HOST`.

Existing affected clusters need `docker compose down && up` — `privileged` cannot be
changed on a live container.
