using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .main) ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ]
);
const main :Workerd.Worker = (
  modules = [ (name = "main.js", esModule = embed "main.js") ],
  compatibilityDate = "2025-09-15",
  bindings = [ (name = "loader", workerLoader = ()) ]
);
