#!/bin/bash -e
cd `cd \`dirname $0\`;pwd`

#need to preprocess first to have the Version.js
test -z $NOBUILD && yarn preprocess

test -z "$VERSION" && VERSION=`jq -r .version ../../packages/bundler/package.json`
echo version=$VERSION

if [ -z "$IMAGE" ]; then
	echo "IMAGE not set. use IMAGE=0xbigboss/bundler"
	exit 1
fi

#build docker image of bundler
#rebuild if there is a newer src file:
find ./dbuild.sh ../../packages/*/src/ -type f -newer dist/bundler.js 2>&1 | head -2 | grep  . && {
	echo webpacking..
	npx webpack
}

if [ -z "$PUSH" ]; then
	echo "== building docker image $IMAGE:$VERSION"

	docker build --load -t $IMAGE .
	docker tag $IMAGE $IMAGE:$VERSION

	echo ""
	echo "== To publish"
	echo "PUSH=1 to build and push"
	exit 0
fi

echo "== pushing docker image $IMAGE:$VERSION"

docker build --platform linux/amd64,linux/arm64 --push -t  $IMAGE:$VERSION .
