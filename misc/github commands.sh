# =================================== #
# DEVELOPMENT MODE 					  #
# =================================== #

## Switch to dev-arsalan and push all changes
	git checkout dev-arsalan
## Activate the environment
	ncopenv311/Scripts/activate
## cd project and run django backend
	python manage.py runserver --settings=ncop_project.settings.dev
### cd frontend and run client side
	npm run dev

# =================================== #
# STAGING MODE 					      #
# =================================== #

## Switch to stage-arsalan
	git checkout stage-arsalan
	git pull origin dev-arsalan --no-commit --no-ff
### cd frontend
	npm run build
### cd project
	python manage.py collectstatic --noinput --settings=ncop_project.settings.staging

## Run the build to see the dev updates working perfectly
### cd frontend
	npm run dev
### cd project
	python -m waitress --port=5000 --host=127.0.0.1 ncop_project.wsgi_staging:application
## Commit changes after validation of dev updates

# =================================== #
# PRODUCTION MODE 					  #
# =================================== #

## Login to VM (install Remote-SSH extension and Ctrl+Shift+P and type Remote-SSH)
### Select Remote-SSH: Add New SSH Host
### Credentials are (cladmin@172.18.7.36 [ password: Rity@890$ ])
### Connect to folder ncop_local/ncop_local_prod

## Activate the environment
	source ncopenv311/bin/activate
## Switch to prod-arsalan
	git checkout prod-arsalan
	git pull origin stage-arsalan --no-commit --no-ff
### cd frontend
	npm run build
### cd project
	python manage.py collectstatic --noinput --settings=ncop_project.settings.prod
### Allow Nginx to read Vite assets
	sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
### Allow Nginx to read Django static files
	sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
### Restart waitress service and check for logs (optional)
	sudo systemctl restart ncop-waitress.service
	sudo systemctl status  ncop-waitress.service
	sudo journalctl -u ncop-waitress.service -f
### Commit the changes after final succesfull review