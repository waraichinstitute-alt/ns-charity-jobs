/* NS Charity Jobs frontend — vanilla JS, Leaflet map view. */
(function () {
  "use strict";

  var SOURCE_NAMES = {
    charityvillage: "CharityVillage",
    winp: "WorkInNonProfits",
    jobbank: "Job Bank",
  };

  var state = { jobs: [], updatedAt: null, view: "list", map: null, cluster: null, mapFailed: false };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function cityOf(loc) {
    return (loc || "").split(",")[0].trim();
  }

  function postedLabel(j) {
    if (j.posted) {
      var days = Math.round((Date.now() - new Date(j.posted + "T00:00:00Z").getTime()) / 86400000);
      if (days <= 0) return "Posted today";
      if (days === 1) return "Posted yesterday";
      return "Posted " + days + " days ago";
    }
    if (j.expires) return "Closing " + j.expires;
    return "Recently posted";
  }

  function primaryLink(j) {
    return (j.links && j.links[0] && j.links[0].url) || "#";
  }

  function renderCard(j) {
    var card = el("article", "card");

    var h2 = el("h2");
    var a = el("a", null, j.title);
    a.href = primaryLink(j);
    a.target = "_blank";
    a.rel = "noopener";
    h2.appendChild(a);
    card.appendChild(h2);

    var emp = el("p", "employer", j.employer);
    if (j.charity) emp.appendChild(el("span", "badge", "✓ Registered charity"));
    card.appendChild(emp);

    var bits = [];
    if (j.location) bits.push(j.location);
    if (j.workModel) bits.push(j.workModel);
    if (j.jobType) bits.push(j.jobType);
    if (j.salary) bits.push(j.salary);
    if (bits.length) {
      var d = el("p", "details");
      bits.forEach(function (b, i) {
        if (i) d.appendChild(el("span", "dot", "·"));
        d.appendChild(document.createTextNode(b));
      });
      card.appendChild(d);
    }

    card.appendChild(el("p", "posted", postedLabel(j)));

    var srcs = el("div", "sources");
    (j.links || []).forEach(function (l, i) {
      var name = SOURCE_NAMES[l.source] || l.source;
      var b = el("a", i === 0 ? "btn" : "btn alt", i === 0 ? "View posting ↗" : "Also on " + name);
      b.href = l.url;
      b.target = "_blank";
      b.rel = "noopener";
      srcs.appendChild(b);
    });
    card.appendChild(srcs);

    return card;
  }

  function currentFilters() {
    return {
      q: document.getElementById("q").value.trim().toLowerCase(),
      city: document.getElementById("city").value,
      jtype: document.getElementById("jtype").value,
      wmodel: document.getElementById("wmodel").value,
      charityOnly: document.getElementById("charityOnly").checked,
    };
  }

  function filteredJobs() {
    var f = currentFilters();
    return state.jobs.filter(function (j) {
      if (f.charityOnly && !j.charity) return false;
      if (f.city && cityOf(j.location) !== f.city) return false;
      if (f.jtype && j.jobType !== f.jtype) return false;
      if (f.wmodel && j.workModel !== f.wmodel) return false;
      if (f.q) {
        var hay = (j.title + " " + j.employer).toLowerCase();
        if (hay.indexOf(f.q) < 0) return false;
      }
      return true;
    });
  }

  function renderList(jobs) {
    var list = document.getElementById("list");
    list.innerHTML = "";
    jobs.forEach(function (j) { list.appendChild(renderCard(j)); });
    document.getElementById("empty").hidden = jobs.length > 0;
  }

  function ensureMap() {
    if (state.map) {
      state.map.invalidateSize();
      return true;
    }
    if (state.mapFailed || typeof L === "undefined") {
      state.mapFailed = true;
      return false;
    }
    try {
      state.map = L.map("map").setView([45.2, -63.2], 7);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(state.map);
      state.cluster = L.markerClusterGroup();
      state.map.addLayer(state.cluster);
      return true;
    } catch (e) {
      state.mapFailed = true;
      return false;
    }
  }

  function popupFor(j) {
    var bits = [j.location, postedLabel(j)].filter(Boolean).join(" · ");
    return '<div class="popup"><strong>' + esc(j.title) + "</strong><br>" +
      esc(j.employer) + (j.charity ? " ✓" : "") + "<br>" +
      '<span class="popup-meta">' + esc(bits) + "</span><br>" +
      '<a href="' + esc(primaryLink(j)) + '" target="_blank" rel="noopener">View posting ↗</a></div>';
  }

  function renderMap(jobs) {
    var note = document.getElementById("mapnote");
    if (!ensureMap()) {
      note.textContent = "The map could not be loaded right now — the list view still works.";
      return;
    }
    state.cluster.clearLayers();
    var pts = [];
    var mapped = 0;
    jobs.forEach(function (j) {
      if (j.lat == null || j.lng == null) return;
      mapped++;
      pts.push([j.lat, j.lng]);
      state.cluster.addLayer(L.marker([j.lat, j.lng]).bindPopup(popupFor(j)));
    });
    if (pts.length) state.map.fitBounds(pts, { padding: [40, 40], maxZoom: 11 });
    var msg = mapped + " of " + jobs.length + " openings on the map";
    if (jobs.length - mapped > 0) {
      msg += " (" + (jobs.length - mapped) + " without a mappable location — see the list view)";
    }
    note.textContent = msg;
  }

  function applyFilters() {
    var jobs = filteredJobs();
    var mapView = state.view === "map";
    document.getElementById("list").hidden = mapView;
    document.getElementById("mapwrap").hidden = !mapView;
    if (mapView) {
      document.getElementById("empty").hidden = true;
      renderMap(jobs);
    } else {
      renderList(jobs);
    }
    document.getElementById("count").textContent =
      jobs.length === state.jobs.length
        ? jobs.length + " current opening" + (jobs.length === 1 ? "" : "s")
        : jobs.length + " of " + state.jobs.length + " openings";
  }

  function setView(v) {
    state.view = v;
    var isMap = v === "map";
    document.getElementById("tab-list").classList.toggle("active", !isMap);
    document.getElementById("tab-map").classList.toggle("active", isMap);
    document.getElementById("tab-list").setAttribute("aria-selected", String(!isMap));
    document.getElementById("tab-map").setAttribute("aria-selected", String(isMap));
    applyFilters();
  }

  function fillCityOptions() {
    var sel = document.getElementById("city");
    var cities = {};
    state.jobs.forEach(function (j) {
      var c = cityOf(j.location);
      if (c) cities[c] = true;
    });
    Object.keys(cities).sort().forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
  }

  function fmtUpdated(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  ["q", "city", "jtype", "wmodel", "charityOnly"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", applyFilters);
    document.getElementById(id).addEventListener("change", applyFilters);
  });
  document.getElementById("tab-list").addEventListener("click", function () { setView("list"); });
  document.getElementById("tab-map").addEventListener("click", function () { setView("map"); });

  fetch("/api/jobs")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      state.jobs = data.jobs || [];
      state.updatedAt = data.updatedAt;
      document.getElementById("meta").textContent =
        "Last updated " + (fmtUpdated(data.updatedAt) || "—") + " · " + (data.count || 0) + " openings";
      fillCityOptions();
      applyFilters();
    })
    .catch(function () {
      document.getElementById("meta").textContent = "Could not load listings right now — please try again later.";
    });
})();
