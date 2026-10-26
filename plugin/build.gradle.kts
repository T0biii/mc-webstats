plugins {
    java
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")
    // Runtime libraries are downloaded by Paper itself (see "libraries" in plugin.yml),
    // so the jar stays tiny and nothing needs to be shaded.
    compileOnly("org.mariadb.jdbc:mariadb-java-client:4.0.0")
    compileOnly("com.zaxxer:HikariCP:7.1.0")
}

tasks.withType<JavaCompile> {
    options.release = 21
    options.encoding = "UTF-8"
}

tasks.processResources {
    inputs.property("version", project.version)
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}

tasks.jar {
    archiveBaseName = "WebStats"
}
