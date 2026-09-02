UUID = shamsi-calendar@gnome.scr.ir
SRC = src
BUILD = build

.PHONY: all schemas pack install uninstall pot test lint clean

all: pack

schemas:
	glib-compile-schemas $(SRC)/schemas

pack: schemas
	mkdir -p $(BUILD)
	gnome-extensions pack --force \
		--extra-source=calendar.js \
		--extra-source=Events.js \
		--extra-source=Tarikh.js \
		--extra-source=otherFunctions.js \
		--extra-source=tahvil.js \
		--extra-source=EDS.js \
		--extra-source=events \
		--out-dir=$(BUILD) $(SRC)

install: pack
	gnome-extensions install --force $(BUILD)/$(UUID).shell-extension.zip
	@echo "Log out/in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
		--package-name="Persian Calendar (Shamsi)" \
		--output=po/shamsi-calendar.pot $(SRC)/*.js

test:
	node --test

lint:
	npx eslint $(SRC)

clean:
	rm -rf $(BUILD) $(SRC)/schemas/gschemas.compiled
