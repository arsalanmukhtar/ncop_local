# NCOP_Document

Welcome to the NCOP Dashboard! This guide will help you understand how the whole system works, from the back-end (Django) to the front-end (Vite and JavaScript), and how everything connects together to show you a beautiful, interactive dashboard.

---

## 1. Django + Vite Setup

### a) Django Project and App
- **Django** is a tool that helps us build websites using Python. Think of it as the engine that powers the website.
- The project is set up in the `project/` folder. Inside, you will find files like `manage.py` (which helps run commands), and folders like `ncop_internal/` and `ncop_project/`.
- The `ncop_internal/` folder is where the main app lives. It has files for handling data, user accounts, and connecting to the website pages.
- Django uses **views** (in `views.py`) to decide what information to show, and **urls** (in `urls.py`) to decide what web address shows what page.
- **Templates** (in `templates/`) are like blueprints for what each page looks like.

### b) Vite Setup
- **Vite** is a tool that helps us build and organize the front-end (the part of the website you see and interact with).
- The `frontend/` folder is where all the Vite files live. It has files like `index.html`, `package.json`, and `vite.config.js`.
- Vite makes it easy to write modern JavaScript and CSS, and then bundles everything together so it loads fast.
- Vite connects to Django by building the front-end and letting Django serve it as part of the website.

---

## 2. Templates, Scripts, and Assets

- **Templates** are found in the `templates/` folder. They are HTML files that decide how each page looks. For example, `dashboard.html` is the main dashboard page.
- **Scripts** (JavaScript files) are in `frontend/src/entries/` and `frontend/src/modules/`. They make the dashboard interactive, like handling buttons, sliders, and maps.
- **Assets** (like images) are in `frontend/src/assets/images/`. These are used to make the dashboard look nice.
- Django uses templates to show pages, and those templates load scripts and assets from the Vite build.
- When you visit the dashboard, Django sends you the template, and Vite's scripts make everything interactive.

---

## 3. Dashboard NCOP Functionality

### How Files Work Together
- **Python files** in `ncop_internal/` handle the data and logic for the website.
- **HTML templates** in `templates/` decide what each page looks like.
- **JavaScript files** in `frontend/src/modules/` and `frontend/src/entries/` make the dashboard interactive. For example:
  - `dashboard_main.js` starts the dashboard.
  - `map-layers.js` handles the map layers.
  - `time-slider-functionality.js` controls the time slider for temporal data.
  - `temporal-layer-legends.js` shows the legend for each map layer.
  - `dashboard.css` styles everything to look nice.
- **CSS files** in `frontend/src/styles/` make sure everything looks good and is easy to use.

### How Everything Connects
- When you open the dashboard, Django sends you the HTML template.
- The template loads the JavaScript and CSS from Vite.
- The JavaScript files talk to each other using imports. For example, `dashboard_main.js` might import functions from `map-layers.js`.
- The dashboard lets you interact with maps, sliders, and buttons. When you click something, JavaScript updates the page instantly.
- The Python back-end can send new data to the front-end if needed, and the front-end can ask for new data from the back-end.

---

## 4. Easy-to-Understand Workflow

Imagine the dashboard as a big interactive poster:
- **Django** is the person who sets up the poster and decides what goes where.
- **Vite** is the artist who draws and colors the poster, making it look cool and interactive.
- **Templates** are the outline of the poster.
- **Scripts** are the moving parts, like sliders and buttons you can play with.
- **Assets** are the pictures and icons that make the poster fun.
- When you visit the dashboard, Django hands you the poster, and Vite makes sure you can play with all the moving parts.

---

## 5. Updating and Adding More Features

This document will be updated as new features are added. If you want to add something new, just follow the same pattern:
- Add new Python code in the Django app for back-end logic.
- Add new JavaScript and CSS in the Vite front-end for interactivity and style.
- Update the templates to show new pages or features.

If you ever get stuck, just ask for help or look at the examples in the code!

---

## 6. JavaScript Modules: What They Do and How They Connect

Below is a simple explanation of what each important JavaScript module (file) does in the NCOP Dashboard, how they talk to each other, and how data moves between them. This will help you understand the workflow, even if you are new to coding!

### How JavaScript Modules Work Together
- Each module is like a helper with a specific job. Some handle maps, some handle buttons, some handle popups, and so on.
- Modules "import" functions from each other, which means they borrow tools or information from other files to do their job.
- When you use the dashboard, these modules work together behind the scenes to make everything interactive and smooth.

### Key Modules and Their Functions

#### dashboard_main.js
- This is the main starter for the dashboard. It loads the dashboard page and makes sure all the other modules are ready to go.
- It connects the map, the sidebar, and the controls so everything works together.

#### map-layers.js
- Handles the different layers you see on the map (like weather, roads, etc.).
- Lets you turn layers on and off, and change how they look.
- Shares information with other modules about which layers are active.

#### time-slider-functionality.js
- Controls the time slider at the bottom of the dashboard.
- Lets you move through different times (like seeing weather change over hours or days).
- Talks to map-layers.js to show the right data for the selected time.
- Uses legends from temporal-layer-legends.js to show what the colors mean.

#### temporal-layer-legends.js
- Shows the legend (the color bar that explains what the map colors mean).
- Makes sure the legend matches the active layer and time.
- Shares legend info with time-slider-functionality.js.

#### layer-attribute-popup.js
- Pops up a small window when you click on a map feature, showing details about it (like name, value, etc.).
- Gets data from the map and shows it in a friendly way.

#### layer-info-panel.js
- Shows extra information about each map layer (like what it is, how it works).
- Lets you see details and descriptions for each layer.

#### layer-order-control.js
- Lets you change the order of layers on the map (which one is on top or bottom).
- Makes sure the map looks the way you want.

#### basemap-panel.js
- Lets you change the background map (like switching from satellite view to street view).
- Shares your choice with the rest of the dashboard.

#### navigation-panel.js
- Handles the navigation buttons (like zoom, pan, home).
- Makes moving around the map easy.

#### sidebar-menu.js
- Controls the sidebar menu where you pick layers, tools, and settings.
- Talks to other modules to update the map and dashboard when you make choices.

#### utility-manager.js
- Provides small helper functions used by other modules (like formatting data, checking settings).
- Makes sure everything runs smoothly and efficiently.

#### dashboard.js
- Handles the main dashboard layout and user interactions.
- Connects the sidebar, map, and controls together.

#### style files (dashboard.css, etc.)
- These are not JavaScript, but they make everything look nice and organized.
- They are used by all modules to keep the dashboard looking modern and easy to use.

### How Data Moves Between Modules
- When you click a button or move a slider, the main dashboard module tells the right helper module what happened.
- For example, if you change the time slider, time-slider-functionality.js updates the map using map-layers.js, and updates the legend using temporal-layer-legends.js.
- If you click on a map feature, layer-attribute-popup.js gets the data from the map and shows it to you.
- All modules share information using imports and function calls, so the dashboard always shows the right data at the right time.

### Where to Find Each Function
- Each module file is in `frontend/src/modules/`.
- The name of the file matches its job (for example, `map-layers.js` handles map layers).
- If you want to change how something works, open the module and look for the function with the same name as the job you want to change.

---

**This section will be updated as new modules and features are added. If you have questions, just look for the module name and its job in this guide!**

---

**NCOP Dashboard is designed to be easy to use and easy to update. Enjoy exploring and building!**
